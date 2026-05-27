// Light-weight yome-skill.json reader. We don't bring in a JSON-Schema
// validator because that would pull ajv (~50KB) into the CLI install size
// for one validation. Instead we hand-check the few invariants the runtime
// actually depends on: slug shape, version semver, domain identifier.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface SkillCommandSummary {
  action: string;
  desc?: string;
  since?: string;
}

export interface SkillBackendDescriptor {
  runtime?: string;
  engine?: string;
  platforms?: string[];
  supports?: string[];
  enabled?: boolean;
  status?: string;
}

export interface SkillAdapterDescriptor {
  prefer?: string[];
}

export interface SkillManifest {
  schemaVersion?: number;
  slug: string;
  name?: string;
  description?: string;
  domain: string;
  version: string;
  official?: boolean;
  homepage?: string;
  repo?: string;
  /**
   * Structured L1 documentation — what the LLM sees in its system prompt
   * for this skill. Three short fields, each one-line, each answers one
   * specific question the model has when deciding whether to invoke:
   *
   *   when    — "user wants to ..."  (the trigger condition)
   *   entry   — first command to discover the rest (typically `<domain> --help`)
   *   effects — truthful side-effects so the model can warn / batch correctly
   *
   * Renderer (cli/src/context.ts → buildHubSkillsSection) emits a 3-row
   * pipe-aligned block; if l1 is absent we fall back to `prompt_line`,
   * then to `<domain> — <description>`.
   */
  l1?: {
    when?: string;
    entry?: string;
    effects?: string;
  };

  /**
   * Legacy single-line "elevator pitch". Used only as a fallback when
   * `l1` is not provided. New skills should prefer `l1`.
   */
  prompt_line?: string;
  platforms?: string[];
  delivery?: Record<string, unknown>;
  backends?: Record<string, SkillBackendDescriptor>;
  adapters?: Record<string, SkillAdapterDescriptor>;
  capabilities?: string[];
  /** OS-level resources the skill needs (M9 security model). One of:
   *  fs:read, fs:write, fs:delete, applescript, network, shell. */
  system_capabilities?: string[];
  tags?: string[];
  license?: string;
  author?: { name?: string; email?: string; github?: string };
  commands?: SkillCommandSummary[];
}

const SLUG_RE = /^@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const DOMAIN_RE = /^[a-z][a-z0-9_]*$/;

export function readManifest(skillDir: string): SkillManifest | null {
  const path = join(skillDir, 'yome-skill.json');
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data == null) return null;
  const m = data as Record<string, unknown>;
  if (typeof m.slug !== 'string' || typeof m.domain !== 'string' || typeof m.version !== 'string') {
    return null;
  }
  return m as unknown as SkillManifest;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Validate just enough to safely install. Schema-level checks are out of scope. */
export function validateManifest(m: SkillManifest): ValidationResult {
  const errors: string[] = [];
  if (!SLUG_RE.test(m.slug)) errors.push(`invalid slug "${m.slug}" (expected @<owner>/<name>)`);
  if (!DOMAIN_RE.test(m.domain)) errors.push(`invalid domain "${m.domain}"`);
  if (!SEMVER_RE.test(m.version)) errors.push(`invalid version "${m.version}" (expected x.y.z)`);
  return { ok: errors.length === 0, errors };
}
