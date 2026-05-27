// Linux device capability detection.
//
// A "capability" is a domain key the Cloud agent's RpcRouter uses to
// pick which device to route a given command to (see
// Server/agent/RpcRouter.findDeviceForCapability). On macOS the list is
// app-bundle-driven (PowerPoint installed → "ppt" capability); on Linux
// the list is tool-binary-driven (docker installed → "docker" capability).
//
// We only declare capabilities whose handler actually exists in
// cli/src/mesh/rpc-handler.ts. Adding a probe here without a handler
// would silently advertise a capability we can't fulfill, which causes
// the Cloud agent to route a command to us and then time out.

import { existsSync, accessSync, constants } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { getInstalledFast } from '../yomeSkills/skillsIndex.js';
import { readManifest } from '../yomeSkills/manifest.js';
import { hasNodeBackend } from '../skills/runner/nodeBackend.js';
import { probePythonBackendSync } from '../skills/runner/pythonBackend.js';

/** Always-on capabilities every Linux box can provide. */
const ALWAYS_ON: string[] = ['bash', 'sh', 'fs', 'net', 'log', 'chat'];

/** Each entry: capability key → predicate. Predicate must be cheap + sync. */
const PROBES: Array<{ cap: string; probe: () => boolean }> = [
  { cap: 'xl',      probe: () => installedSkillCapabilityReady('xl') },
  { cap: 'git',     probe: () => onPath('git') },
  { cap: 'docker',  probe: () => onPath('docker') },
  { cap: 'k8s',     probe: () => onPath('kubectl') },
  { cap: 'systemd', probe: () => existsSync('/run/systemd/system') || onPath('systemctl') },
  { cap: 'pkg',     probe: () => onPath('apt-get') || onPath('dnf') || onPath('yum') || onPath('apk') || onPath('pacman') },
  { cap: 'svc',     probe: () => onPath('systemctl') || onPath('service') },
];

/**
 * Run all probes once and return the union of always-on caps + detected
 * caps. Called at registrar startup and on demand if the user invokes
 * `yome mesh refresh-caps` (todo).
 */
export function detectCapabilities(): string[] {
  const detected = new Set<string>(ALWAYS_ON);
  for (const { cap, probe } of PROBES) {
    try {
      if (probe()) detected.add(cap);
    } catch {
      // Probe failures must never throw; treat as "capability not present".
    }
  }
  return Array.from(detected).sort();
}

function installedSkillCapabilityReady(domain: string): boolean {
  const entry = getInstalledFast().find((s) => s.domain === domain && s.status === 'enabled');
  if (!entry) return false;
  const manifest = readManifest(entry.installedAt);
  if (!manifest) return false;
  const adapter = manifest.adapters?.[normalisedPlatform()];
  const preferred = adapter?.prefer ?? [];
  for (const backendId of preferred) {
    const desc = manifest.backends?.[backendId];
    if (desc?.enabled === false || desc?.status === 'stub') continue;
    if (!backendPlatformMatches(desc?.platforms)) continue;
    const runtime = backendRuntime(backendId, desc?.runtime);
    if (runtime === 'python' && probePythonBackendSync(entry.installedAt).ok) return true;
    if (runtime === 'node' && hasNodeBackend(entry.installedAt)) return true;
    if (
      runtime === 'applescript' &&
      process.platform === 'darwin' &&
      existsSync(join(entry.installedAt, 'backends', 'macos', 'manifest.json'))
    ) {
      return true;
    }
  }
  return false;
}

function backendPlatformMatches(platforms: string[] | undefined): boolean {
  if (!platforms || platforms.length === 0) return true;
  return platforms.includes(normalisedPlatform()) || platforms.includes('node');
}

function backendRuntime(id: string, runtime: string | undefined): 'python' | 'node' | 'applescript' | 'unknown' {
  const value = (runtime ?? id).toLowerCase();
  if (value.includes('python')) return 'python';
  if (value.includes('node')) return 'node';
  if (value.includes('applescript') || value.includes('osascript') || value.includes('macos')) return 'applescript';
  return 'unknown';
}

function normalisedPlatform(): 'linux' | 'macos' | 'windows' | string {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return process.platform;
}

/** Best-effort PATH lookup that does NOT spawn a child if avoidable. */
function onPath(bin: string): boolean {
  // 1. Walk $PATH directly. Cheap, no fork/exec.
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(':').filter(Boolean)) {
    const candidate = `${dir}/${bin}`;
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch { /* try next */ }
  }
  // 2. Final fallback to `command -v` in case PATH was weird (e.g. nss).
  // Wrapped in try because non-zero exit throws synchronously.
  try {
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
