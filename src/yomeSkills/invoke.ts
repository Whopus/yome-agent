// cli/src/yomeSkills/invoke.ts
//
// Top-level entry point for "execute an action on an installed hub
// skill". Handles slug/domain resolution, capability enforcement, and
// platform/backend selection. Both the `SkillCall` agent tool and the
// `yome <domain> <action>` CLI route through this.

import { homedir } from 'os';
import { getInstalledFast, type SkillIndexEntry } from './skillsIndex.js';
import { readManifest, type SkillBackendDescriptor, type SkillManifest } from './manifest.js';
import { isCapabilityAllowed } from './capabilities.js';
import {
  dispatchMacos,
  loadMacosBackend,
  type SkillCall as DispatchCall,
} from '../skills/runner/dispatcher.js';
import { dispatchNode, hasNodeBackend } from '../skills/runner/nodeBackend.js';
import { dispatchPython, hasPythonBackend } from '../skills/runner/pythonBackend.js';

/** Expand ~ in a path arg the same way a shell would. */
function expandTilde(v: string | boolean | number | undefined): string | boolean | number | undefined {
  if (typeof v !== 'string') return v;
  if (v === '~') return homedir();
  if (v.startsWith('~/')) return homedir() + v.slice(1);
  return v;
}

export interface InvokeRequest {
  /** Either '@owner/name' (preferred) or just a domain like 'ppt'. */
  slugOrDomain: string;
  /** Action name, e.g. 'new', 'slide.add'. */
  action: string;
  positionals?: string[];
  flags?: Record<string, string | boolean | number | undefined>;
  /** Host cwd for relative path resolution inside headless adapters. */
  workingDirectory?: string;
}

export interface InvokeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Diagnostic — which skill we resolved to. */
  resolvedSlug?: string;
}

/**
 * Find the installed skill record for either `@owner/name` or `<domain>`.
 * Domain lookup picks the first installed skill that owns that domain;
 * if you have multiple, prefer the explicit slug.
 */
export function resolveSkill(slugOrDomain: string): SkillIndexEntry | null {
  const installed = getInstalledFast();
  if (slugOrDomain.startsWith('@')) {
    return installed.find((s) => s.slug === slugOrDomain) ?? null;
  }
  return installed.find((s) => s.domain === slugOrDomain) ?? null;
}

/**
 * Run an action. Honors capability grants — anything the manifest
 * declares as required (and that hasn't been allowed by the user) blocks
 * the call before we touch osascript.
 */
export async function invokeSkill(req: InvokeRequest): Promise<InvokeResult> {
  const entry = resolveSkill(req.slugOrDomain);
  if (!entry) {
    return {
      ok: false, stdout: '', stderr: `skill not installed: ${req.slugOrDomain}`,
      exitCode: 127,
    };
  }
  if (entry.status !== 'enabled') {
    return {
      ok: false, stdout: '', stderr: `skill ${entry.slug} is disabled — enable it via /skills`,
      exitCode: 1, resolvedSlug: entry.slug,
    };
  }

  const manifest = readManifest(entry.installedAt);
  if (!manifest) {
    return {
      ok: false, stdout: '', stderr: `failed to read manifest at ${entry.installedAt}`,
      exitCode: 1, resolvedSlug: entry.slug,
    };
  }

  // Enforce declared OS-level capabilities (security model).
  // Note: manifest.capabilities holds *semantic* labels (calendar:read);
  // system_capabilities holds the OS-level set we actually gate on.
  const declared = (manifest.system_capabilities ?? []) as Array<
    'fs:read' | 'fs:write' | 'fs:delete' | 'applescript' | 'network' | 'shell'
  >;
  const missing: string[] = [];
  for (const cap of declared) {
    if (!isCapabilityAllowed(entry.slug, cap)) missing.push(cap);
  }
  if (missing.length > 0) {
    return {
      ok: false, stdout: '',
      stderr:
        `capability not granted: ${missing.join(', ')}\n` +
        `Run: yome skill perms ${entry.slug} --grant ${missing[0]}`,
      exitCode: 13, resolvedSlug: entry.slug,
    };
  }

  const positionals = (req.positionals ?? []).map((p) =>
    typeof p === 'string' ? (expandTilde(p) as string) : p,
  );
  const flags: Record<string, string | boolean | number | undefined> = {};
  for (const [k, v] of Object.entries(req.flags ?? {})) {
    flags[k] = expandTilde(v);
  }
  const call: DispatchCall & { workingDirectory?: string } = {
    positionals,
    flags,
    workingDirectory: req.workingDirectory,
  };

  const backendOrder = backendPreference(manifest, req.action, entry.domain);
  const skipped: string[] = [];
  for (const backendId of backendOrder) {
    const desc = manifest.backends?.[backendId];
    if (desc?.enabled === false || desc?.status === 'stub') {
      skipped.push(`${backendId}: disabled`);
      continue;
    }
    if (!backendSupportsAction(desc, req.action)) {
      skipped.push(`${backendId}: action unsupported`);
      continue;
    }
    if (!backendSupportsPlatform(desc)) {
      skipped.push(`${backendId}: platform mismatch`);
      continue;
    }

    const runtime = backendRuntime(backendId, desc);
    if (runtime === 'python') {
      if (!hasPythonBackend(entry.installedAt)) {
        skipped.push(`${backendId}: missing backends/python`);
        continue;
      }
      const r = await dispatchPython(entry.installedAt, req.action, call);
      return { ...r, resolvedSlug: entry.slug };
    }
    if (runtime === 'node') {
      if (!hasNodeBackend(entry.installedAt)) {
        skipped.push(`${backendId}: missing backends/node`);
        continue;
      }
      const r = await dispatchNode(entry.installedAt, req.action, call);
      return { ...r, resolvedSlug: entry.slug };
    }
    if (runtime === 'applescript') {
      if (process.platform !== 'darwin') {
        skipped.push(`${backendId}: darwin only`);
        continue;
      }
      if (!loadMacosBackend(entry.installedAt)) {
        skipped.push(`${backendId}: missing backends/macos/manifest.json`);
        continue;
      }
      const r = dispatchMacos(entry.installedAt, req.action, call);
      return { ...r, resolvedSlug: entry.slug };
    }
    skipped.push(`${backendId}: unknown runtime`);
  }

  return {
    ok: false,
    stdout: '',
    stderr:
      `no usable backend for ${entry.slug} action "${req.action}" on ${normalisedPlatform()}.\n` +
      `Tried: ${backendOrder.join(', ') || '(none)'}${skipped.length ? `\nSkipped: ${skipped.join('; ')}` : ''}`,
    exitCode: 2,
    resolvedSlug: entry.slug,
  };
}

function backendPreference(manifest: SkillManifest, action: string, domain: string): string[] {
  const override = backendOverride(domain);
  if (override && override !== 'auto') return backendIdsForOverride(manifest, override);

  const adapter = manifest.adapters?.[normalisedPlatform()];
  if (adapter?.prefer && adapter.prefer.length > 0) return adapter.prefer;

  // Legacy fallback for skills that have not adopted adapter/backend
  // metadata yet: preserve the old CLI behaviour.
  const legacy = ['node'];
  if (process.platform === 'darwin') legacy.push('applescript');
  return legacy.filter((id) => backendSupportsAction(manifest.backends?.[id], action));
}

function backendOverride(domain: string): string | null {
  const scoped = process.env[`YOME_${domain.toUpperCase()}_BACKEND`];
  return (scoped ?? process.env.YOME_SKILL_BACKEND ?? null)?.trim() || null;
}

function backendIdsForOverride(manifest: SkillManifest, override: string): string[] {
  const key = override.toLowerCase();
  if (manifest.backends?.[override]) return [override];
  const matches = Object.entries(manifest.backends ?? {})
    .filter(([id, desc]) => backendRuntime(id, desc) === key || id.toLowerCase().startsWith(key))
    .map(([id]) => id);
  if (matches.length > 0) return matches;
  if (key === 'python' || key === 'node' || key === 'applescript') return [key];
  if (key === 'macos' || key === 'osascript') return ['applescript'];
  return [override];
}

function backendSupportsAction(desc: SkillBackendDescriptor | undefined, action: string): boolean {
  const supports = desc?.supports;
  if (!supports || supports.length === 0) return true;
  return supports.includes('*') || supports.includes(action);
}

function backendSupportsPlatform(desc: SkillBackendDescriptor | undefined): boolean {
  const platforms = desc?.platforms;
  if (!platforms || platforms.length === 0) return true;
  return platforms.includes(normalisedPlatform()) || platforms.includes('node');
}

function backendRuntime(id: string, desc: SkillBackendDescriptor | undefined): 'python' | 'node' | 'applescript' | 'unknown' {
  const runtime = (desc?.runtime ?? id).toLowerCase();
  if (runtime.includes('python')) return 'python';
  if (runtime.includes('node')) return 'node';
  if (runtime.includes('applescript') || runtime.includes('osascript') || runtime.includes('macos')) return 'applescript';
  return 'unknown';
}

function normalisedPlatform(): 'linux' | 'macos' | 'windows' | string {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return process.platform;
}
