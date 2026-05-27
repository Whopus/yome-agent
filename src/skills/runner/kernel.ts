// cli/src/skills/runner/kernel.ts
//
// Yome agentic bash kernel.
//
// The LLM in cli only ever sees one execution tool: `Bash`. To let it
// invoke installed hub skills with the same ergonomic command-line shape
// a human would type (`ppt new ~/Desktop/x.pptx`), the Bash tool calls
// `tryKernel` BEFORE handing anything to /bin/sh. The kernel:
//
//   1. Tokenises the line (quote-aware; no shell expansion).
//   2. Refuses to handle compound lines (pipes, &&, ;, redirects, subshell)
//      so genuine shell stays as shell.
//   3. Refuses to handle reserved tokens (git, ls, cd, ...) — those are
//      always real shell, never skill invocations.
//   4. If tokens[0] matches an installed hub skill's `domain`, runs the
//      action via invokeSkill — same path the macOS app uses, including
//      capability gating.
//   5. Supports `--help` at three levels (global / domain / action) and
//      renders compact TSV-ish text the LLM can scan cheaply.
//
// Anything the kernel doesn't claim falls through to plain shell.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tokenize, looksCompound, splitOnUnquotedAmpAmp } from './tokenizer.js';
import { getInstalledFast, type SkillIndexEntry } from '../../yomeSkills/skillsIndex.js';
import { readManifest } from '../../yomeSkills/manifest.js';
import { invokeSkill } from '../../yomeSkills/invoke.js';
import { loadMacosBackend } from './dispatcher.js';

// ── Types ───────────────────────────────────────────────────────────

export interface KernelResult {
  /** false → caller (Bash tool) should run the line via /bin/sh as usual. */
  handled: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Anything that's a system command we actively want to stay as a real
// shell call. We refuse to interpret these as a skill domain even if a
// future user installs a same-named skill — safety first.
const RESERVED_SYSTEM_COMMANDS = new Set([
  // Coreutils + common
  'ls', 'cd', 'pwd', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch',
  'cat', 'head', 'tail', 'less', 'more', 'grep', 'find', 'sort', 'uniq', 'wc',
  'echo', 'printf', 'true', 'false', 'test', 'tr', 'sed', 'awk', 'cut',
  // Shells
  'sh', 'bash', 'zsh', 'fish', 'env',
  // Tooling
  'git', 'gh', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'open', 'osascript',
  'node', 'npm', 'pnpm', 'yarn', 'npx', 'tsc',
  'python', 'python3', 'pip', 'pip3', 'ruby', 'go', 'cargo', 'rustc',
  'java', 'javac', 'mvn', 'gradle',
  'docker', 'kubectl', 'make',
  // Yome itself — `yome <subcmd>` always means the cli, never a skill domain
  'yome',
]);

// ── Public entry ────────────────────────────────────────────────────

export async function tryKernel(commandLine: string): Promise<KernelResult> {
  const trimmed = commandLine.trim();
  if (!trimmed) return notHandled();

  // ── Batch mode (must come BEFORE looksCompound — heredoc uses `<<`) ──
  // Two accepted shapes:
  //   <domain> batch <<EOF\n...\nEOF
  //   <domain> batch\n<cmd>\n<cmd>...
  // Both are claimed by the kernel even when the closing tag is missing
  // so we can return a useful error instead of silently passing the
  // heredoc to /bin/sh and letting the user wonder what happened.
  //
  // Carve out `<domain> batch --help` first — that's a help request, not
  // a batch invocation with an empty body.
  const helpSnif = trimmed.match(/^(\w+)\s+batch\b\s+(--help|-h)\b\s*$/);
  if (helpSnif) {
    const installedHelp = getInstalledFast().filter((s) => s.status === 'enabled');
    const sk = installedHelp.find((s) => s.domain === helpSnif[1]);
    if (sk) return ok(renderBatchHelp(sk));
  }

  const batch = parseBatchCommand(trimmed);
  if (batch) return runBatch(batch);

  // ── `xl X && xl Y && ...` chains ───────────────────────────────
  // If a line is ONLY composed of hub-skill invocations joined by
  // top-level `&&`, the kernel runs them sequentially with short-circuit
  // semantics rather than handing the whole compound line to /bin/sh
  // (which would just say "xl: command not found"). Anything that's
  // not a pure skill chain (mixed shell + skill, presence of `|`/`;`/
  // redirect/subshell, unknown domains, --help mid-chain) falls through
  // to looksCompound below and out to real shell.
  if (trimmed.includes('&&')) {
    const chainResult = await tryRunSkillChain(trimmed);
    if (chainResult) return chainResult;
  }

  // Compound shell stays shell.
  if (looksCompound(trimmed)) return notHandled();

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return notHandled();

  const first = tokens[0]!;

  // Global help — only when the user explicitly typed something we own.
  // We don't claim a bare `--help` because that might mean something else
  // in the host shell.
  if (first === 'yome-skills' && (tokens.length === 1 || tokens[1] === '--help')) {
    return ok(renderGlobalHelp());
  }

  if (RESERVED_SYSTEM_COMMANDS.has(first)) return notHandled();

  // Find the installed hub skill whose `domain` matches token[0].
  // Domains are short strings declared in yome-skill.json (e.g. "ppt").
  const installed = getInstalledFast().filter((s) => s.status === 'enabled');
  const skill = installed.find((s) => s.domain === first);
  if (!skill) return notHandled();

  // From here on we *own* the line. Help routes return ok() with help text;
  // execution routes go through invokeSkill.
  // ppt --help / ppt -h
  if (tokens.length === 1 || tokens[1] === '--help' || tokens[1] === '-h') {
    return ok(renderDomainHelp(skill));
  }

  // ppt --doc        → list templates from skill repo's docs/
  // ppt --doc <name> → read that specific template
  if (tokens[1] === '--doc') {
    if (tokens.length === 2) return ok(renderDocList(skill));
    return ok(renderDocOne(skill, tokens[2]!));
  }

  const action = tokens[1]!;

  // ppt batch --help — kernel-level meta action.
  if (action === 'batch' && (tokens.includes('--help') || tokens.includes('-h'))) {
    return ok(renderBatchHelp(skill));
  }

  // ppt <action> --help
  if (tokens.includes('--help') || tokens.includes('-h')) {
    return ok(renderActionHelp(skill, action));
  }

  // Parse argv: collect positionals + flags
  const { positionals, flags, parseError } = parseArgs(tokens.slice(2));
  if (parseError) {
    return err(parseError + '\n\n' + renderActionHelp(skill, action), 2);
  }

  const r = await invokeSkill({
    slugOrDomain: skill.slug,
    action,
    positionals,
    flags,
  });

  return {
    handled: true,
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode,
  };
}

// ── `<domain> X && <domain> Y && ...` chain runner ───────────────────
//
// Returns:
//   - null  → not a pure skill chain (caller should keep going / fall to shell)
//   - KernelResult → kernel handled the whole chain
//
// Acceptance criteria for "pure skill chain":
//   * line splits on top-level `&&` into >= 2 segments
//   * every segment, after tokenize+trim, starts with a token that maps
//     to an installed+enabled hub-skill domain
//   * no segment is a meta-action we can't safely chain (batch/help/--doc) —
//     those would interact with the chain in surprising ways, so we let
//     real shell handle them (exits 127, but only if user really wrote
//     `xl --help && xl batch ...` which is nonsensical anyway)
//
// Execution semantics: bash-like `&&` short-circuit. Stop on first
// non-zero exit; return that exit code. Stdout is the concatenation of
// each successful segment's stdout; stderr is the failing segment's
// stderr (mirroring `bash -c 'a && b && c'`).
async function tryRunSkillChain(line: string): Promise<KernelResult | null> {
  const segments = splitOnUnquotedAmpAmp(line);
  if (segments.length < 2) return null;

  const installed = getInstalledFast().filter((s) => s.status === 'enabled');
  const domains = new Set(installed.map((s) => s.domain));

  // Pre-flight: every segment must (a) tokenize to >= 1 token, (b) lead
  // with a known skill domain, (c) NOT be a meta-action.
  for (const seg of segments) {
    if (looksCompound(seg)) return null; // segment itself has |/;/redirect
    const toks = tokenize(seg);
    if (toks.length === 0) return null;
    const head = toks[0]!;
    if (RESERVED_SYSTEM_COMMANDS.has(head)) return null;
    if (!domains.has(head)) return null;
    // Refuse to chain meta-actions — they have non-standard exit semantics.
    const sub = toks[1];
    if (sub === 'batch' || sub === '--help' || sub === '-h' || sub === '--doc') return null;
  }

  // All-skill chain confirmed. Execute sequentially, short-circuiting on
  // first non-zero exit.
  const stdoutParts: string[] = [];
  let lastResult: KernelResult = { handled: true, stdout: '', stderr: '', exitCode: 0 };

  for (const seg of segments) {
    const r = await tryKernel(seg);
    if (!r.handled) {
      // Defensive — pre-flight should have caught this. Bail to shell.
      return null;
    }
    if (r.stdout) stdoutParts.push(r.stdout);
    lastResult = r;
    if (r.exitCode !== 0) {
      return {
        handled: true,
        stdout: stdoutParts.join('\n'),
        stderr: r.stderr,
        exitCode: r.exitCode,
      };
    }
  }
  return {
    handled: true,
    stdout: stdoutParts.join('\n'),
    stderr: lastResult.stderr,
    exitCode: 0,
  };
}

// ── argv parser ─────────────────────────────────────────────────────

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | number>;
  parseError?: string;
}

function parseArgs(rest: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | number> = {};

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;

    // --flag=value
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq > 0) {
        const key = tok.slice(2, eq);
        flags[key] = tok.slice(eq + 1);
        continue;
      }
      // --flag (bare). Either consume next non-flag token as value, or
      // treat as boolean true.
      const key = tok.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }

    // Plain positional
    positionals.push(tok);
  }

  return { positionals, flags };
}

// ── Help renderers ──────────────────────────────────────────────────

/**
 * `yome-skills` (global) — list all installed hub skills.
 */
function renderGlobalHelp(): string {
  const all = getInstalledFast().filter((s) => s.status === 'enabled');
  if (all.length === 0) {
    return [
      'No hub skills installed.',
      '',
      'Install one with:',
      '  yome skill install github:<owner>/<repo>',
      'Browse the hub:',
      '  https://yome.work/skills',
    ].join('\n');
  }

  const lines: string[] = [];
  lines.push('Installed hub skills (use `<domain> --help` for actions):');
  lines.push('');
  lines.push(['DOMAIN', 'SLUG', 'VERSION', 'DESCRIPTION'].join('\t'));
  for (const s of all) {
    lines.push([s.domain ?? '?', s.slug, s.version ?? '?', s.description ?? ''].join('\t'));
  }
  return lines.join('\n');
}

/**
 * `<domain> --help` — Layer-2 signature documentation.
 *
 * Resolution order:
 *   1. Skill repo's `SIGNATURE.md` (authored by the skill maintainer —
 *      this is what shows up to the LLM and should be hand-tuned for
 *      LLM consumption: one line per action, defaults inline, no
 *      hidden compression tricks).
 *   2. Auto-generated from backends/macos/manifest.json args (so newly
 *      published skills always have *something* to show).
 *
 * We append a tiny footer about batch + --doc so the model knows those
 * exist without the skill author having to remember.
 */
function renderDomainHelp(skill: SkillIndexEntry): string {
  const sigPath = join(skill.installedAt, 'SIGNATURE.md');
  let body: string;

  if (existsSync(sigPath)) {
    try {
      body = readFileSync(sigPath, 'utf-8').trim();
    } catch {
      body = renderAutoSignature(skill);
    }
  } else {
    body = renderAutoSignature(skill);
  }

  const footer = [
    '',
    `--- batch + docs ---`,
    `${skill.domain} batch [--keep-going] [--merge] <<EOF\\n<cmd1>\\n<cmd2>\\nEOF`,
    `${skill.domain} --doc                  list available templates / cookbooks`,
    `${skill.domain} --doc <name>           read one template`,
    `${skill.domain} <action> --help        per-action argument detail`,
  ].join('\n');

  return body + '\n' + footer;
}

/**
 * Fallback when the skill repo doesn't ship a SIGNATURE.md. We render
 * a usable signature from the backend manifest — verbose but always works.
 * Skill authors are encouraged to hand-write SIGNATURE.md to override this.
 */
function renderAutoSignature(skill: SkillIndexEntry): string {
  const manifest = readManifest(skill.installedAt);
  const backend = loadMacosBackend(skill.installedAt);

  const lines: string[] = [];
  lines.push(`${skill.domain} — ${skill.name ?? skill.slug} (${skill.slug} v${skill.version ?? '?'})`);
  if (skill.description) lines.push(skill.description);
  lines.push('');

  // Build a one-line-per-action signature from the manifest args.
  if (backend) {
    for (const [action, spec] of Object.entries(backend.actions)) {
      const positionals: string[] = [];
      const flags: string[] = [];
      for (const a of spec.args ?? []) {
        const isPositional = a.from.split('|').some((s) => s.trim() === 'positional');
        if (isPositional) {
          positionals.push(a.required ? `<${a.name}>` : `[${a.name}]`);
        } else {
          const flagName = a.from.split('|').map((s) => s.trim()).find((s) => s.startsWith('--')) ?? `--${a.name}`;
          if (a.type === 'bool') {
            flags.push(`[${flagName}]`);
          } else {
            flags.push(a.required ? `${flagName}=<${a.name}>` : `[${flagName}=<${a.name}>]`);
          }
        }
      }
      const tail = [...positionals, ...flags].join(' ');
      let desc = '';
      if (manifest && Array.isArray(manifest.commands)) {
        for (const c of manifest.commands as Array<{ action?: string; desc?: string }>) {
          if (c.action === action && c.desc) { desc = `   # ${c.desc}`; break; }
        }
      }
      lines.push(`  ${skill.domain} ${action}${tail ? ' ' + tail : ''}${desc}`);
    }
  } else {
    lines.push('  (no backend installed for this platform)');
  }
  return lines.join('\n');
}

/**
 * `<domain> <action> --help` — list args for one action by reading the
 * macOS backend manifest. Falls back to a generic message when there's
 * no backend installed.
 */
function renderActionHelp(skill: SkillIndexEntry, action: string): string {
  const backend = loadMacosBackend(skill.installedAt);
  const manifest = readManifest(skill.installedAt);

  // Pull the human-friendly description from manifest.commands when available.
  let desc: string | undefined;
  if (manifest && Array.isArray(manifest.commands)) {
    for (const c of manifest.commands as Array<{ action?: string; desc?: string }>) {
      if (c.action === action) { desc = c.desc; break; }
    }
  }

  if (!backend) {
    return `${skill.domain} ${action} — no macOS backend installed for this skill.`;
  }
  const spec = backend.actions[action];
  if (!spec) {
    const known = Object.keys(backend.actions).join(', ');
    return `Unknown action: ${skill.domain} ${action}\nAvailable: ${known}`;
  }

  const lines: string[] = [];
  lines.push(`${skill.domain} ${action}${desc ? ' — ' + desc : ''}`);
  lines.push('');

  const positionalArgs = (spec.args ?? []).filter((a) =>
    a.from.split('|').some((s) => s.trim() === 'positional'),
  );
  const flagArgs = (spec.args ?? []).filter((a) =>
    a.from.split('|').some((s) => s.trim().startsWith('--')),
  );

  if (positionalArgs.length > 0) {
    lines.push('POSITIONAL');
    for (const a of positionalArgs) {
      const req = a.required ? ' (required)' : '';
      const def = a.default !== undefined && a.default !== '' && a.default !== false
        ? ` [default: ${String(a.default)}]`
        : '';
      lines.push(`  <${a.name}>${req}${def}`);
    }
    lines.push('');
  }

  if (flagArgs.length > 0) {
    lines.push('FLAGS');
    for (const a of flagArgs) {
      const req = a.required ? ' (required)' : '';
      const def = a.default !== undefined && a.default !== '' && a.default !== false
        ? ` [default: ${String(a.default)}]`
        : '';
      const ty = a.type ? ` (${a.type})` : '';
      // Pick the first --flag form for the display name (handles "positional|--path").
      const flagName = a.from.split('|').map((s) => s.trim()).find((s) => s.startsWith('--')) ?? `--${a.name}`;
      lines.push(`  ${flagName}${ty}${req}${def}`);
    }
    lines.push('');
  }

  if (spec.uses && spec.uses.length > 0) {
    lines.push(`Capabilities: ${spec.uses.join(', ')}`);
  }
  return lines.join('\n');
}

// ── --doc: skill cookbook (templates / themes / recipes) ────────────
//
// Skills can ship a `docs/` folder where each .md file is a *template*
// — a worked example, a visual theme spec, an end-to-end cookbook page.
// We surface them via:
//
//   <domain> --doc          → list available templates (frontmatter-driven)
//   <domain> --doc <name>   → read one template
//
// Frontmatter convention (each docs/<file>.md):
//
//   ---
//   name: blue-white
//   label: 蓝白风格 / Blue & White
//   summary: 蓝白配色的商务简洁模板，适合季度回顾
//   tags: [theme, business]
//   ---
//   <body>
//
// The `name` field is the lookup key; `label` is the human-readable
// display name; `summary` is the one-liner for the list.

interface DocFrontmatter {
  name: string;
  label?: string;
  summary?: string;
  tags?: string[];
}

interface DocEntry {
  name: string;
  label: string;
  summary: string;
  tags: string[];
  /** Absolute path to the .md file. */
  path: string;
}

function listDocs(skill: SkillIndexEntry): DocEntry[] {
  const docDir = join(skill.installedAt, 'docs');
  if (!existsSync(docDir)) return [];
  const entries: DocEntry[] = [];
  let names: string[] = [];
  try { names = readdirSync(docDir); } catch { return []; }
  for (const file of names) {
    if (!file.toLowerCase().endsWith('.md')) continue;
    const full = join(docDir, file);
    try {
      const raw = readFileSync(full, 'utf-8');
      const fm = parseFrontmatter(raw);
      const fallbackName = file.replace(/\.md$/i, '');
      entries.push({
        name: fm?.name ?? fallbackName,
        label: fm?.label ?? fm?.name ?? fallbackName,
        summary: fm?.summary ?? '',
        tags: fm?.tags ?? [],
        path: full,
      });
    } catch { /* skip unreadable files */ }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function renderDocList(skill: SkillIndexEntry): string {
  const docs = listDocs(skill);
  if (docs.length === 0) {
    return [
      `${skill.domain} — no templates / docs available.`,
      `(skill maintainer hasn't shipped a docs/ folder)`,
    ].join('\n');
  }
  const lines: string[] = [];
  lines.push(`${skill.domain} — ${docs.length} template(s) available. Read one with \`${skill.domain} --doc <name>\`.`);
  lines.push('');
  lines.push(['NAME', 'LABEL', 'SUMMARY'].join('\t'));
  for (const d of docs) {
    lines.push([d.name, d.label, d.summary].join('\t'));
  }
  return lines.join('\n');
}

function renderDocOne(skill: SkillIndexEntry, name: string): string {
  const docs = listDocs(skill);
  const doc = docs.find((d) => d.name === name)
    ?? docs.find((d) => d.name.toLowerCase() === name.toLowerCase())
    ?? docs.find((d) => d.label === name);
  if (!doc) {
    const known = docs.map((d) => d.name).join(', ') || '(none)';
    return `${skill.domain} --doc: unknown template '${name}'.\nAvailable: ${known}`;
  }
  // Strip the frontmatter on output — the body is what the LLM consumes.
  const raw = readFileSync(doc.path, 'utf-8');
  const body = stripFrontmatter(raw);
  return `# ${doc.label}\n\n${body.trim()}\n\n— from ${skill.domain} --doc ${doc.name}`;
}

/**
 * Parse a `--- ... ---` YAML-ish frontmatter block. We only support a
 * tiny subset (key: value, key: [v1, v2]) — enough for skill docs and
 * trivially diffable. Returns null when the file has no frontmatter.
 */
function parseFrontmatter(raw: string): DocFrontmatter | null {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return null;
  const obj: Record<string, unknown> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!.trim();
    let val: unknown = kv[2]!.trim();
    // tiny array literal: [a, b, "c d"]
    if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
      val = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else if (typeof val === 'string') {
      val = val.replace(/^["']|["']$/g, '');
    }
    obj[key] = val;
  }
  if (typeof obj.name !== 'string') return null;
  return {
    name: obj.name,
    label: typeof obj.label === 'string' ? obj.label : undefined,
    summary: typeof obj.summary === 'string' ? obj.summary : undefined,
    tags: Array.isArray(obj.tags) ? (obj.tags as string[]) : undefined,
  };
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
}

function renderBatchHelp(skill: SkillIndexEntry): string {
  return [
    `${skill.domain} batch — run several actions in a single Bash call`,
    ``,
    `USAGE`,
    `  ${skill.domain} batch [flags] <<TAG`,
    `  <cmd1>`,
    `  <cmd2>`,
    `  ...`,
    `  TAG`,
    ``,
    `or simple newline form:`,
    `  ${skill.domain} batch [flags]`,
    `  <cmd1>`,
    `  <cmd2>`,
    ``,
    `FLAGS`,
    `  --keep-going    don't stop on first failure (default: fail-fast)`,
    `  --merge         render all sub-commands as one osascript invocation`,
    `                  (5-10x faster; skips Launch Services actions like 'open')`,
    ``,
    `BODY RULES`,
    `  - One sub-command per line, NO domain prefix`,
    `  - '# inline comments' and blank lines are skipped`,
    `  - Quotes (\"...\" or '...') work the same as single-line commands`,
    `  - Heredoc tag can be any word: <<EOF / <<BATCH / <<DONE`,
    ``,
    `EXAMPLE`,
    `  ${skill.domain} batch <<EOF`,
    `  new ~/Desktop/x.pptx`,
    `  title 1 --text=\"Hello\"`,
    `  slide.add`,
    `  save`,
    `  EOF`,
  ].join('\n');
}

// ── Batch mode ──────────────────────────────────────────────────────
//
// `<domain> batch <<TAG\n<cmd1>\n<cmd2>\n...\nTAG`
// `<domain> batch\n<cmd1>\n<cmd2>\n...`
//
// Both forms are used in the macOS app today (see Server/agent/commandParser).
// We replicate them here so an LLM that already knows the macOS DSL Just Works.
//
// Supported flags:
//   --keep-going    don't stop on first failure (default: fail-fast like make)
//   --merge         render every sub-command's .applescript and run them as a
//                   single osascript invocation (~5-10x faster, but stricter
//                   about which actions are mergeable)

interface BatchInvocation {
  domain: string;
  body: string;
  flags: { keepGoing: boolean; merge: boolean };
}

interface BatchSubcommand {
  action: string;
  positionals: string[];
  flags: Record<string, string | boolean | number>;
  /** original line, kept for error messages */
  raw: string;
}

/**
 * Detects + parses the two batch forms. Returns null when the line is
 * NOT a batch invocation; returns a populated object otherwise (even on
 * malformed heredoc — the runner will turn that into a useful error so
 * we don't silently fall through to /bin/sh).
 */
function parseBatchCommand(commandLine: string): BatchInvocation | null {
  const normalised = commandLine.replace(/\r\n/g, '\n').trim();

  // Heredoc form. First line: `<domain> batch [flags] <<TAG`
  // Body until matching TAG on its own line.
  const heredoc = normalised.match(
    /^(\w+)\s+batch\b([^\n]*?)<<(['"]?)(\w+)\3[ \t]*\n([\s\S]*?)\n[ \t]*\4[ \t]*$/,
  );
  if (heredoc) {
    const [, domain, headFlags, , , body] = heredoc;
    return { domain, body, flags: parseBatchFlags(headFlags) };
  }

  // Simple newline form. First line: `<domain> batch [flags]`. Body = rest.
  const simple = normalised.match(/^(\w+)\s+batch\b([^\n]*)\n([\s\S]+)$/);
  if (simple) {
    const [, domain, headFlags, body] = simple;
    return { domain, body, flags: parseBatchFlags(headFlags) };
  }

  // Bare `<domain> batch` with no body — likely a typo. Claim it so we
  // can surface a help message rather than running it as a real shell
  // command (which would just fail with `batch: command not found`).
  const bare = normalised.match(/^(\w+)\s+batch\b([^\n]*)$/);
  if (bare) {
    const [, domain, headFlags] = bare;
    return { domain, body: '', flags: parseBatchFlags(headFlags) };
  }

  return null;
}

function parseBatchFlags(headRest: string): { keepGoing: boolean; merge: boolean } {
  const tokens = tokenize(headRest.trim());
  return {
    keepGoing: tokens.includes('--keep-going') || tokens.includes('-k'),
    merge: tokens.includes('--merge'),
  };
}

/**
 * Strip a trailing inline `# comment` while respecting quotes.
 * `#` is only a comment marker at line start or after whitespace, so
 * `--color=#FF0000` doesn't get truncated.
 */
function stripInlineComment(line: string): string {
  let inQuote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuote) {
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") { inQuote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

/**
 * Tokenise + group each non-empty body line into a sub-command. We don't
 * validate against the manifest here — the dispatcher does that, and we
 * want the same error reporting whether the call came from batch or a
 * single line.
 */
function splitBatchBody(body: string): BatchSubcommand[] {
  const out: BatchSubcommand[] = [];
  for (const rawLine of body.split('\n')) {
    const stripped = stripInlineComment(rawLine).trim();
    if (!stripped) continue;
    if (stripped.startsWith('#')) continue;

    const tokens = tokenize(stripped);
    if (tokens.length === 0) continue;
    const action = tokens[0]!;

    // Reuse the same argv parser we use for the single-command path.
    const { positionals, flags } = parseArgs(tokens.slice(1));
    out.push({ action, positionals, flags, raw: stripped });
  }
  return out;
}

async function runBatch(b: BatchInvocation): Promise<KernelResult> {
  const installed = getInstalledFast().filter((s) => s.status === 'enabled');
  const skill = installed.find((s) => s.domain === b.domain);
  if (!skill) {
    return err(`batch: unknown domain '${b.domain}' (no installed skill owns it)`, 127);
  }

  if (!b.body.trim()) {
    return err(
      `batch: empty body. Usage:\n` +
        `  ${b.domain} batch <<EOF\n  <cmd1>\n  <cmd2>\n  EOF\n` +
        `or\n` +
        `  ${b.domain} batch\n  <cmd1>\n  <cmd2>\n` +
        `Flags: --keep-going (don't stop on first failure), --merge (single osascript run)`,
      2,
    );
  }

  const subs = splitBatchBody(b.body);
  if (subs.length === 0) {
    return err(`batch: no executable commands found (only blank lines / comments?)`, 2);
  }

  if (b.flags.merge) {
    return runBatchMerged(skill, subs, b.flags.keepGoing);
  }

  // Default: simple loop, fail-fast unless --keep-going.
  const lines: string[] = [];
  let lastErr = '';
  let failed = 0;

  for (let i = 0; i < subs.length; i++) {
    const s = subs[i]!;
    const r = await invokeSkill({
      slugOrDomain: skill.slug,
      action: s.action,
      positionals: s.positionals,
      flags: s.flags,
    });
    if (r.exitCode !== 0) {
      failed++;
      lastErr = `[line ${i + 1}: ${s.raw}] ${r.stderr || r.stdout || `exit ${r.exitCode}`}`;
      lines.push(`✗ ${s.action}: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`}`);
      if (!b.flags.keepGoing) break;
    } else {
      const txt = (r.stdout || '').trim();
      lines.push(`✓ ${s.action}${txt ? ': ' + txt : ''}`);
    }
  }

  const stdout = lines.join('\n');
  const summary =
    failed === 0
      ? `\n— batch ok (${subs.length} commands)`
      : `\n— batch finished: ${subs.length - failed}/${subs.length} ok, ${failed} failed`;
  return {
    handled: true,
    stdout: stdout + summary,
    stderr: lastErr,
    exitCode: failed === 0 ? 0 : 1,
  };
}

/**
 * --merge path: render every sub-command's AppleScript template, splice
 * them into a single source, and call osascript once. We import lazily
 * (and from the dispatcher module so the merged path stays in one file).
 */
async function runBatchMerged(
  skill: SkillIndexEntry,
  subs: BatchSubcommand[],
  keepGoing: boolean,
): Promise<KernelResult> {
  const { dispatchMacosBatchMerged } = await import('./dispatcher.js');
  const r = await dispatchMacosBatchMerged(
    skill.installedAt,
    subs.map((s) => ({ action: s.action, call: { positionals: s.positionals, flags: s.flags } })),
    { keepGoing },
  );
  return {
    handled: true,
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode,
  };
}

// ── small helpers ───────────────────────────────────────────────────

function ok(out: string): KernelResult {
  return { handled: true, stdout: out, stderr: '', exitCode: 0 };
}
function err(msg: string, code = 1): KernelResult {
  return { handled: true, stdout: '', stderr: msg, exitCode: code };
}
function notHandled(): KernelResult {
  return { handled: false, stdout: '', stderr: '', exitCode: 0 };
}
