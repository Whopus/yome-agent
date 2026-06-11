import { execSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { loadAllSkills } from './skills/index.js';
import type { Skill } from './skills/index.js';
import { getInstalledFast } from './yomeSkills/skillsIndex.js';
import { readManifest } from './yomeSkills/manifest.js';

function safeExec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, timeout: 5000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function getFileTree(dir: string, depth = 2, prefix = ''): string {
  if (depth < 0) return '';
  const lines: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const filtered = entries.filter(
      (e) => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__',
    );
    for (const entry of filtered.slice(0, 30)) {
      const isDir = entry.isDirectory();
      lines.push(`${prefix}${entry.name}${isDir ? '/' : ''}`);
      if (isDir && depth > 0) {
        lines.push(getFileTree(join(dir, entry.name), depth - 1, prefix + '  '));
      }
    }
    if (filtered.length > 30) lines.push(`${prefix}... (${filtered.length - 30} more)`);
  } catch { /* ignore */ }
  return lines.filter(Boolean).join('\n');
}

// ── Caches for the per-cwd metadata block ───────────────────────────
//
// `buildSystemPrompt()` runs on agent construction AND on every
// resetContext / restoreSession / reloadSkills. Each call previously
// shelled out to `git rev-parse`, `git status --porcelain`, and walked
// the project tree synchronously. On a busy session that's a measurable
// stutter every time the user runs `/new` or installs a skill.
//
// Cache key: cwd. TTL: 60s. Long enough that interactive use is fast,
// short enough that branch switches / git status changes show up
// without a CLI restart.
interface CwdMetaCache {
  cwd: string;
  expiresAt: number;
  gitBranch: string | null;
  gitStatus: string | null;
  tree: string;
}
let _cwdMetaCache: CwdMetaCache | null = null;
const CWD_META_TTL_MS = 60_000;

function getCwdMeta(cwd: string): CwdMetaCache {
  const now = Date.now();
  if (_cwdMetaCache && _cwdMetaCache.cwd === cwd && _cwdMetaCache.expiresAt > now) {
    return _cwdMetaCache;
  }
  _cwdMetaCache = {
    cwd,
    expiresAt: now + CWD_META_TTL_MS,
    gitBranch: safeExec('git rev-parse --abbrev-ref HEAD', cwd),
    gitStatus: safeExec('git status --porcelain', cwd),
    tree: getFileTree(cwd),
  };
  return _cwdMetaCache;
}

/** Force a re-fetch of git/tree info on next buildSystemPrompt call. */
export function invalidateCwdMeta(): void {
  _cwdMetaCache = null;
}

export function buildSystemPrompt(): string {
  const cwd = process.cwd();
  const projectName = basename(cwd);
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  const meta = getCwdMeta(cwd);
  const gitBranch = meta.gitBranch;
  const gitStatus = meta.gitStatus;
  const isGit = gitBranch !== null;
  const tree = meta.tree;

  let prompt = `You are Yome, an AI coding assistant running in the user's terminal.

## Environment
- Date: ${dateStr}
- Working directory: ${cwd}
- Project: ${projectName}
- OS: ${process.platform} ${process.arch}
- Node: ${process.version}
`;

  if (isGit) {
    prompt += `- Git branch: ${gitBranch}\n`;
  }

  prompt += `
## Guidelines
- Use absolute paths when calling tools.
- Read files before editing them.
- Be concise in responses.
- When editing code, preserve the existing style and patterns.
- NEVER wrap your response in \`\`\`markdown fences. Output markdown directly.
- Verify changes work before reporting completion.
- Never expose secrets or API keys.
`;

  // Prompt-style skills (Claude Code-format SKILL.md)
  const skills = loadAllSkills();
  if (skills.length > 0) {
    prompt += buildSkillsSection(skills);
  }

  // Hub skills — filter out domains already covered by built-in tools (fs, sh)
  const CLI_BUILTIN_DOMAINS = new Set(['fs', 'sh']);
  const hubSkills = getInstalledFast().filter((s) => s.status === 'enabled' && !CLI_BUILTIN_DOMAINS.has(s.domain));
  if (hubSkills.length > 0) {
    prompt += buildHubSkillsSection(hubSkills);
  }

  return prompt;
}

/**
 * Prompt skills (Claude Code SKILL.md format) get the same 3-row L1
 * shape as hub skills, just with different field sources:
 *   when    ← frontmatter `when_to_use` (or `description` as fallback)
 *   effects ← always "loads markdown body into context (prompt-only)"
 *             unless the SKILL.md explicitly grants `allowed-tools`
 *   start   ← `/skill-name [argument-hint]`
 *
 * Same visual shape means the model doesn't have to context-switch
 * between two different docs styles when scanning available skills.
 */
function buildSkillsSection(skills: Skill[]): string {
  let section = `\nPrompt skills (invoke with \`/skill-name [args]\`):\n\n`;
  for (const skill of skills) {
    const head = `/${skill.name}`;
    const pad = ' '.repeat(head.length);
    const when = skill.whenToUse ?? skill.description;
    const entry = skill.argumentHint ? `/${skill.name} ${skill.argumentHint}` : `/${skill.name}`;
    const effects = (skill.allowedTools && skill.allowedTools.length > 0)
      ? `runs tools: ${skill.allowedTools.join(', ')}`
      : `prompt-only (no tools)`;

    section += `${head} | when:    ${when}\n`;
    section += `${pad} | effects: ${effects}\n`;
    section += `${pad} | start:   ${entry}\n`;
  }
  return section;
}

/**
 * Hub skills are surfaced to the LLM in three layers:
 *   L1 — this section: ONE skill = THREE short rows answering the only
 *        questions the model actually has when picking a tool —
 *          when    (trigger condition)
 *          effects (truthful side effects)
 *          start   (first command to discover the rest)
 *        Authored as `l1: { when, entry, effects }` in yome-skill.json.
 *   L2 — `<domain> --help` (kernel reads SIGNATURE.md, fallback auto-gen).
 *   L3 — `<domain> --doc [name]` for cookbook templates / themes.
 *
 * The model is told once, in the footer, that --help / --doc / batch exist
 * for every installed skill — so individual L1 blocks stay focused on
 * the trigger / effects / entry triad.
 */
function buildHubSkillsSection(entries: ReturnType<typeof getInstalledFast>): string {
  let section = `\n### Installed skills (invoke via Yome tool: \`<domain> <action> [args]\`)\n\n`;
  for (const e of entries) {
    const manifest = readManifest(e.installedAt);
    section += renderL1Block(e.domain, manifest, e.description) + '\n';
  }
  section += `\nFor any skill: \`<domain> --help\` for usage, \`<domain> --doc\` for templates.\n`;
  return section;
}

/**
 * Render the 3-row pipe-aligned L1 block for one skill. Falls back to
 * legacy `prompt_line`, then to `<domain> — <description>` so older
 * yome-skill.json files keep producing *something* useful.
 */
function renderL1Block(domain: string, manifest: ReturnType<typeof readManifest>, fallbackDesc?: string): string {
  const l1 = manifest?.l1;

  if (l1 && (l1.when || l1.entry || l1.effects)) {
    // Right-pad the domain column so the pipes line up vertically — easier
    // for the model to scan when several skills are listed.
    const head = domain;
    const pad = ' '.repeat(head.length);
    const lines: string[] = [];
    if (l1.when)    lines.push(`${head} | when:    ${l1.when}`);
    if (l1.effects) lines.push(`${pad} | effects: ${l1.effects}`);
    if (l1.entry)   lines.push(`${pad} | start:   ${l1.entry}`);
    return lines.join('\n');
  }

  // Legacy single-line fallback — keeps backward compat with skills that
  // used `prompt_line` before the structured l1 schema landed.
  if (manifest?.prompt_line) {
    return `- ${manifest.prompt_line}`;
  }

  return `- ${domain} — ${fallbackDesc ?? '(no description provided)'}`;
}
