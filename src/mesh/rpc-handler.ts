// Dispatch incoming rpc:cal-request frames to local Linux tools and
// send the result back as rpc:cal-response.
//
// Mirror of the macOS path in Yome/YomeApp.swift::BridgeMessage.request,
// which routes by `parsed.domain` to a per-domain bridge. Here on Linux:
//
//   domain=bash → spawn /bin/sh and stream output
//   domain=fs   → file system operations (full POSIX paths, no sandbox)
//   domain=xl   → installed @yome/xl skill backend when available
//
// Tool-binary domains (git / docker / k8s / systemd / pkg / log / svc / net)
// are advertised as capabilities but currently return a friendly
// "not implemented yet" so the Cloud agent can fall back gracefully.
//
// fs actions implemented here (mirrors yome-skill-fs/signature/fs.signature.json):
//   ls / tree / stat / find / read (alias cat) / head / tail
//   write / append / mkdir / edit / cp / mv / rm
//   grep — system rg (or fallback grep), line-numbered matches
//   glob — fast-glob multi-pattern + exclude
//
// IMPORTANT path conventions on Linux mesh (different from macOS sandbox!):
//   - There is NO Desktop/Downloads/Documents sandbox; full POSIX paths allowed.
//   - `~` and `~/foo` are expanded to the daemon user's $HOME.
//   - A missing/empty path is treated as the mesh working directory captured
//     when `yome mesh start` was launched.
//   - A relative path is resolved against that mesh working directory.

import { spawn } from 'child_process';
import { promises as fsp } from 'fs';
import { homedir } from 'os';
import { basename, join, resolve as resolvePath, isAbsolute } from 'path';
import fg from 'fast-glob';
import type { PartyKitClient } from './partykit-client.js';
import type { WsRpcRequest, WsRpcResponse } from './types.js';
import { invokeSkill } from '../yomeSkills/invoke.js';

const BASH_TIMEOUT_MS = 60_000;
const MAX_STDOUT_CHARS = 64_000;
const TEXT_SAMPLE_BYTES = 8192;

export interface RpcHandlerOpts {
  /** Directory where shell/fs commands should run. Defaults to process.cwd(). */
  workingDirectory?: string;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

// ──────────────────────────────────────────────────────────────────────
// Path helpers — shared by every fs action so behaviour is identical
// across read/write/grep/glob.
// ──────────────────────────────────────────────────────────────────────

/** Expand a leading `~` to $HOME. `~user` is intentionally NOT supported. */
function expandTilde(p: string): string {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve a user-supplied path with consistent semantics on Linux mesh:
 *   - empty / undefined → mesh working directory
 *   - leading `~` → $HOME-relative
 *   - absolute → kept as-is
 *   - relative → resolved against mesh working directory
 */
function resolveUserPath(raw: string | undefined, fallbackToWorkingDirectory = true, workingDirectory = process.cwd()): string {
  const s = (raw ?? '').trim();
  if (!s) {
    if (fallbackToWorkingDirectory) return workingDirectory;
    return '';
  }
  const expanded = expandTilde(s);
  if (isAbsolute(expanded)) return expanded;
  return resolvePath(workingDirectory, expanded);
}

/**
 * Extract the path argument from a parsed fs command.
 * Server-side commandParser stores the bare positional under `args.positional`
 * (see Server/agent/commandParser.ts:558). Older code paths and the
 * yome-skill-fs signature use `--path=`, so we accept both.
 */
function pathArg(args: Record<string, unknown>, fallbackToWorkingDirectory = true, workingDirectory = process.cwd()): string {
  const fromPath = typeof args.path === 'string' ? args.path : '';
  const fromPos = typeof args.positional === 'string' ? args.positional : '';
  return resolveUserPath(fromPath || fromPos, fallbackToWorkingDirectory, workingDirectory);
}

function looksBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const sample = buf.subarray(0, Math.min(buf.length, TEXT_SAMPLE_BYTES));
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) control++;
  }
  return control > 16 || (sample.length >= 512 && control / sample.length > 0.02);
}

async function readTextFile(target: string, label: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const buf = await fsp.readFile(target);
  if (looksBinary(buf)) {
    return {
      ok: false,
      error: `[fs ${label}] ${target} appears to be binary (${buf.length} bytes). Use a file-specific parser or chat show/download instead.`,
    };
  }
  return { ok: true, content: buf.toString('utf-8') };
}

function intArg(args: Record<string, unknown>, key: string, dflt: number): number {
  const v = args[key];
  if (typeof v !== 'string') return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function strArg(args: Record<string, unknown>, key: string, dflt = ''): string {
  const v = args[key];
  return typeof v === 'string' ? v : dflt;
}

function boolArg(args: Record<string, unknown>, key: string): boolean {
  return args[key] === 'true' || args[key] === true;
}

function skillCallFromParsedArgs(args: Record<string, unknown>): {
  positionals: string[];
  flags: Record<string, string | boolean | number | undefined>;
} {
  const positionals: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const key = i === 1 ? 'positional' : `positional${i}`;
    const value = args[key];
    if (value !== undefined && value !== null && String(value) !== '') {
      positionals.push(String(value));
    }
  }

  const flags: Record<string, string | boolean | number | undefined> = {};
  for (const [key, value] of Object.entries(args)) {
    if (/^positional\d*$/.test(key)) continue;
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
      flags[key] = value;
    } else if (value !== undefined && value !== null) {
      flags[key] = String(value);
    }
  }
  return { positionals, flags };
}

function humanSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
}

// ──────────────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────────────

export class RpcHandler {
  private detach: (() => void) | null = null;
  private readonly workingDirectory: string;

  constructor(private client: PartyKitClient, private opts: RpcHandlerOpts = {}) {
    this.workingDirectory = resolvePath(opts.workingDirectory ?? process.cwd());
  }

  start(): void {
    this.detach = this.client.onMessage((frame) => {
      let parsed: unknown;
      try { parsed = JSON.parse(frame); } catch { return; }
      const obj = parsed as { type?: string };
      if (obj?.type !== 'rpc:cal-request') return;
      const req = obj as unknown as WsRpcRequest;
      // Don't await: each RPC handled independently so a slow bash
      // command doesn't block the receive loop.
      void this.handleRequest(req);
    });
  }

  stop(): void {
    this.detach?.();
    this.detach = null;
  }

  private async handleRequest(req: WsRpcRequest): Promise<void> {
    this.log('info', 'rpc:cal-request', {
      requestId: req.requestId, command: req.command, domain: req.parsed?.domain,
    });
    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = await this.dispatch(req);
    } catch (err) {
      result = { stdout: '', stderr: `[handler] ${(err as Error).message}`, exitCode: 1 };
    }
    // Cap stdout to avoid blowing past WS frame limits.
    if (result.stdout.length > MAX_STDOUT_CHARS) {
      result.stdout = result.stdout.slice(0, MAX_STDOUT_CHARS) + `\n[stdout capped at ${MAX_STDOUT_CHARS} chars]`;
    }
    const response: WsRpcResponse = {
      type: 'rpc:cal-response',
      requestId: req.requestId,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
    try {
      await this.client.send(response);
    } catch (err) {
      this.log('error', 'failed to send rpc response', { err: (err as Error).message });
    }
  }

  private async dispatch(req: WsRpcRequest): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const domain = req.parsed?.domain;
    switch (domain) {
      case 'bash':
      case 'sh':
        return this.handleBash(req);
      case 'fs':
        return this.handleFs(req);
      case 'xl':
        return this.handleXl(req);
      // Capabilities we advertise but haven't implemented yet:
      case 'git':
      case 'docker':
      case 'k8s':
      case 'systemd':
      case 'pkg':
      case 'log':
      case 'net':
      case 'svc':
        return {
          stdout: '',
          stderr: `[mesh] domain '${domain}' not implemented on linux cli yet — use \`bash exec --cmd="..."\` instead`,
          exitCode: 127,
        };
      default:
        return {
          stdout: '',
          stderr: `[mesh] unknown domain: ${domain} (linux cli implements: sh, fs, and installed skill domains such as xl). For shell access use \`sh <command>\`.`,
          exitCode: 127,
        };
    }
  }

  private async handleXl(req: WsRpcRequest): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const action = req.parsed?.action ?? '';
    if (!action) return { stdout: '', stderr: '[xl] action is required', exitCode: 2 };
    const { positionals, flags } = skillCallFromParsedArgs((req.parsed?.args ?? {}) as Record<string, unknown>);
    const r = await invokeSkill({
      slugOrDomain: 'xl',
      action,
      positionals,
      flags,
      workingDirectory: this.workingDirectory,
    });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  }

  /**
   * Handles both `bash` (legacy: --cmd=…) and `sh` (new top-level shell
   * domain: everything after the leading `sh ` token is the shell
   * line). Resolution order:
   *   1. parsed.args.cmd — legacy `bash exec --cmd="..."`
   *   2. req.command with leading `sh ` / `bash ` stripped — `sh find / | xargs grep ...`
   *   3. raw req.command as last resort.
   */
  private handleBash(req: WsRpcRequest): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    let shellLine = (req.parsed?.args?.cmd as string | undefined) ?? '';
    if (!shellLine) {
      const raw = (req.command ?? '').trim();
      const stripped = raw.replace(/^(?:sh|bash)\s+/i, '');
      shellLine = unwrapSingleQuotedShellLine(stripped || raw);
    }
    if (!shellLine.trim()) {
      return Promise.resolve({ stdout: '', stderr: '[bash] empty command', exitCode: 2 });
    }
    return new Promise((resolveP) => {
      const proc = spawn('sh', ['-c', shellLine], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: this.workingDirectory,
      });
      let stdout = '';
      let stderr = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      }, BASH_TIMEOUT_MS);
      proc.stdout.on('data', (b) => { stdout += b.toString('utf-8'); });
      proc.stderr.on('data', (b) => { stderr += b.toString('utf-8'); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (killed) {
          resolveP({ stdout, stderr: `[bash] timed out after ${BASH_TIMEOUT_MS / 1000}s`, exitCode: 124 });
        } else {
          resolveP({ stdout, stderr, exitCode: code ?? 1 });
        }
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        resolveP({ stdout: '', stderr: `[bash] spawn error: ${err.message}`, exitCode: 1 });
      });
    });
  }

  /**
   * `fs <action> [<path>] [--key=value ...]`
   * Path resolution: see `resolveUserPath` — empty → mesh working directory,
   * ~ expanded, relative → mesh working directory, full POSIX paths allowed.
   */
  private async handleFs(req: WsRpcRequest): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const action = req.parsed?.action ?? '';
    const args = (req.parsed?.args ?? {}) as Record<string, unknown>;
    const root = this.workingDirectory;

    try {
      switch (action) {
        case 'ls': {
          const target = pathArg(args, true, root);
          const entries = await fsp.readdir(target, { withFileTypes: true });
          // Output TSV: `name\ttype\tsize` so the Server-side fsDomain.ls
          // compress() (which filters on `\t`) actually sees rows. Header
          // line lets compress() detect it. Sort: dirs first, then by name.
          entries.sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          const rows: string[] = ['name\ttype\tsize'];
          for (const e of entries) {
            const full = join(target, e.name);
            let sizeStr = '-';
            if (e.isFile()) {
              try { const st = await fsp.stat(full); sizeStr = humanSize(st.size); } catch { /* keep '-' */ }
            }
            const kind = e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file';
            rows.push(`${e.name}\t${kind}\t${sizeStr}`);
          }
          return { stdout: `${target}:\n${rows.join('\n')}`, stderr: '', exitCode: 0 };
        }

        case 'tree': {
          const target = pathArg(args, true, root);
          const depth = Math.max(1, intArg(args, 'depth', 2));
          const out: string[] = [target];
          await walkTree(target, depth, '', out);
          return { stdout: out.join('\n'), stderr: '', exitCode: 0 };
        }

        case 'stat': {
          const target = pathArg(args, false, root);
          if (!target) return { stdout: '', stderr: '[fs stat] path is required', exitCode: 2 };
          const st = await fsp.stat(target);
          const info = {
            name: basename(target) || target,
            path: target,
            type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'file',
            size: st.size,
            sizeFormatted: humanSize(st.size),
            modifiedAt: st.mtime.toISOString(),
            createdAt: st.birthtime.toISOString(),
            mode: '0' + (st.mode & 0o777).toString(8),
          };
          return { stdout: JSON.stringify(info), stderr: '', exitCode: 0 };
        }

        case 'find': {
          // fs find <path> --name=GLOB [--type=file|dir] [--limit=20]
          const target = pathArg(args, true, root);
          const namePat = strArg(args, 'name');
          if (!namePat) return { stdout: '', stderr: '[fs find] --name is required', exitCode: 2 };
          const typeFilter = strArg(args, 'type');
          const limit = Math.max(1, intArg(args, 'limit', 20));
          const matches = await fg([`**/${namePat}`], {
            cwd: target,
            dot: true,
            onlyFiles: typeFilter === 'file' ? true : typeFilter === 'dir' ? false : false,
            onlyDirectories: typeFilter === 'dir',
            absolute: true,
            suppressErrors: true,
            ignore: ['**/node_modules/**', '**/.git/**'],
          });
          if (matches.length === 0) {
            return { stdout: 'path\tname\nNo matches found\t-', stderr: '', exitCode: 0 };
          }
          const shown = matches.slice(0, limit);
          // TSV so Server-side compress() picks rows correctly.
          const rows = ['path\tname', ...shown.map((p) => `${p}\t${basename(p)}`)];
          const tail = matches.length > limit
            ? `\n[showing ${limit} of ${matches.length}; raise --limit or narrow --name]`
            : '';
          return { stdout: rows.join('\n') + tail, stderr: '', exitCode: 0 };
        }

        case 'cat':
        case 'read': {
          const target = pathArg(args, false, root);
          if (!target) return { stdout: '', stderr: '[fs read] path is required', exitCode: 2 };
          const st = await fsp.stat(target);
          if (st.isDirectory()) {
            return {
              stdout: '',
              stderr: `[fs read] ${target} is a directory — use \`fs ls ${shellQuote(target)}\` instead`,
              exitCode: 1,
            };
          }
          const read = await readTextFile(target, 'read');
          if (!read.ok) return { stdout: '', stderr: read.error, exitCode: 1 };
          const content = read.content;
          const lines = intArg(args, 'lines', 50);
          const offset = Math.max(0, intArg(args, 'offset', 0));
          if (offset === 0 && lines >= content.split('\n').length) {
            return { stdout: content, stderr: '', exitCode: 0 };
          }
          const all = content.split('\n');
          const slice = all.slice(offset, offset + lines).join('\n');
          return { stdout: slice, stderr: '', exitCode: 0 };
        }

        case 'head': {
          const target = pathArg(args, false, root);
          if (!target) return { stdout: '', stderr: '[fs head] path is required', exitCode: 2 };
          const lines = Math.max(1, intArg(args, 'lines', 10));
          const read = await readTextFile(target, 'head');
          if (!read.ok) return { stdout: '', stderr: read.error, exitCode: 1 };
          const content = read.content;
          return { stdout: content.split('\n').slice(0, lines).join('\n'), stderr: '', exitCode: 0 };
        }

        case 'tail': {
          const target = pathArg(args, false, root);
          if (!target) return { stdout: '', stderr: '[fs tail] path is required', exitCode: 2 };
          const lines = Math.max(1, intArg(args, 'lines', 10));
          const read = await readTextFile(target, 'tail');
          if (!read.ok) return { stdout: '', stderr: read.error, exitCode: 1 };
          const content = read.content;
          return { stdout: content.split('\n').slice(-lines).join('\n'), stderr: '', exitCode: 0 };
        }

        case 'mkdir': {
          const target = pathArg(args, false, root);
          if (!target) return { stdout: '', stderr: '[fs mkdir] path is required', exitCode: 2 };
          await fsp.mkdir(target, { recursive: true });
          return { stdout: `created ${target}`, stderr: '', exitCode: 0 };
        }

        case 'write': {
          const target = pathArg(args, false, root);
          if (!target) return { stdout: '', stderr: '[fs write] path is required', exitCode: 2 };
          const content = strArg(args, 'content');
          const force = boolArg(args, 'force');
          if (!force) {
            try {
              await fsp.access(target);
              return { stdout: '', stderr: `[fs write] ${target} already exists; pass --force=true to overwrite`, exitCode: 1 };
            } catch { /* file doesn't exist — fine */ }
          }
          await fsp.mkdir(join(target, '..'), { recursive: true });
          await fsp.writeFile(target, content, 'utf-8');
          return { stdout: `wrote ${content.length} bytes to ${target}`, stderr: '', exitCode: 0 };
        }

        case 'append': {
          const target = pathArg(args, false, root);
          if (!target) return { stdout: '', stderr: '[fs append] path is required', exitCode: 2 };
          const content = strArg(args, 'content');
          await fsp.mkdir(join(target, '..'), { recursive: true });
          await fsp.appendFile(target, content, 'utf-8');
          return { stdout: `appended ${content.length} bytes to ${target}`, stderr: '', exitCode: 0 };
        }

        case 'edit': {
          const target = pathArg(args, false, root);
          if (!target) return { stdout: '', stderr: '[fs edit] path is required', exitCode: 2 };
          const oldStr = strArg(args, 'old');
          const newStr = strArg(args, 'new');
          const all = boolArg(args, 'all');
          if (!oldStr) return { stdout: '', stderr: '[fs edit] --old is required', exitCode: 2 };
          let original: string;
          try {
            original = await fsp.readFile(target, 'utf-8');
          } catch (err) {
            return { stdout: '', stderr: `[fs edit] cannot read ${target}: ${(err as Error).message}`, exitCode: 1 };
          }
          if (!all) {
            const first = original.indexOf(oldStr);
            if (first === -1) return { stdout: '', stderr: '[fs edit] --old not found in file', exitCode: 1 };
            const second = original.indexOf(oldStr, first + oldStr.length);
            if (second !== -1) {
              return {
                stdout: '',
                stderr: '[fs edit] --old appears multiple times; provide more surrounding context for a unique match, or pass --all=true to replace every occurrence',
                exitCode: 1,
              };
            }
            const next = original.slice(0, first) + newStr + original.slice(first + oldStr.length);
            await fsp.writeFile(target, next, 'utf-8');
            return { stdout: `replaced 1 occurrence in ${target}`, stderr: '', exitCode: 0 };
          }
          const parts = original.split(oldStr);
          const count = parts.length - 1;
          if (count === 0) return { stdout: '', stderr: '[fs edit] --old not found in file', exitCode: 1 };
          await fsp.writeFile(target, parts.join(newStr), 'utf-8');
          return { stdout: `replaced ${count} occurrence(s) in ${target}`, stderr: '', exitCode: 0 };
        }

        case 'cp':
        case 'mv': {
          const src = pathArg(args, false, root);
          const dst = resolveUserPath(strArg(args, 'to'), false, root);
          if (!src || !dst) {
            return { stdout: '', stderr: `[fs ${action}] both <path> and --to=<dest> are required`, exitCode: 2 };
          }
          const force = boolArg(args, 'force');
          try {
            await fsp.access(dst);
            if (!force) {
              return { stdout: '', stderr: `[fs ${action}] ${dst} already exists; pass --force=true to overwrite`, exitCode: 1 };
            }
          } catch { /* target doesn't exist — fine */ }
          await fsp.mkdir(join(dst, '..'), { recursive: true });
          if (action === 'mv') {
            await fsp.rename(src, dst);
          } else {
            // Node 16.7+ has fsp.cp; use recursive for dirs.
            await fsp.cp(src, dst, { recursive: true, force: true });
          }
          return { stdout: `${action} ${src} → ${dst}`, stderr: '', exitCode: 0 };
        }

        case 'rm': {
          const target = pathArg(args, false, root);
          if (!target) return { stdout: '', stderr: '[fs rm] path is required', exitCode: 2 };
          const recursive = boolArg(args, 'recursive');
          await fsp.rm(target, { recursive, force: false });
          return { stdout: `removed ${target}`, stderr: '', exitCode: 0 };
        }

        case 'grep':
          return this.handleFsGrep(req);
        case 'glob':
          return this.handleFsGlob(req);

        default:
          return {
            stdout: '',
            stderr: `[fs] unknown action: ${action} (linux supports: ls, tree, stat, find, read/cat, head, tail, write, append, mkdir, edit, cp, mv, rm, grep, glob)`,
            exitCode: 127,
          };
      }
    } catch (err) {
      const msg = (err as NodeJS.ErrnoException).code === 'EISDIR'
        ? `${(err as Error).message} — use \`fs ls\` for directories`
        : (err as Error).message;
      return { stdout: '', stderr: `[fs] ${msg}`, exitCode: 1 };
    }
  }

  /**
   * `fs grep <pattern> [path] [--type=ts] [--glob=*.md] [--context=2] [-i]
   *  [--fixed=true] [--limit=200]` — ripgrep when present, fallback to grep.
   * Both pattern and path support positional/--flag entry, with ~ expansion
   * via resolveUserPath and relative paths rooted at the mesh working directory.
   */
  private handleFsGrep(req: WsRpcRequest): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const args = (req.parsed?.args ?? {}) as Record<string, unknown>;
    // pattern: bare positional, OR --pattern=. The path (if any) is parsed
    // server-side as positional2.
    const pattern = strArg(args, 'pattern') || strArg(args, 'positional');
    if (!pattern) {
      return Promise.resolve({ stdout: '', stderr: '[fs grep] pattern is required', exitCode: 2 });
    }
    const pathRaw = strArg(args, 'path') || strArg(args, 'positional2');
    const searchPath = resolveUserPath(pathRaw, true, this.workingDirectory);
    const caseInsensitive = boolArg(args, 'i');
    const fixed = boolArg(args, 'fixed');
    const globFilter = strArg(args, 'glob');
    const typeFilter = strArg(args, 'type');
    const ctx = Math.max(0, intArg(args, 'context', 0));
    const limit = Math.max(1, intArg(args, 'limit', 200));

    return new Promise((resolveP) => {
      const probe = spawn('which', ['rg'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let probeOut = '';
      probe.stdout.on('data', (b) => { probeOut += b.toString('utf-8'); });
      probe.on('close', (code) => {
        const useRg = code === 0 && probeOut.trim().length > 0;
        const argv: string[] = useRg
          ? ['rg', '-n', '--max-columns', '500', '--glob', '!.git', '--glob', '!node_modules']
          : ['grep', '-rn'];
        if (useRg) {
          if (caseInsensitive) argv.push('-i');
          if (fixed) argv.push('-F');
          if (globFilter) argv.push('--glob', globFilter);
          if (typeFilter) argv.push('--type', typeFilter);
          if (ctx > 0) argv.push('-C', String(ctx));
        } else {
          if (caseInsensitive) argv.push('-i');
          if (fixed) argv.push('-F');
          if (ctx > 0) argv.push('-C', String(ctx));
          if (globFilter) argv.push(`--include=${globFilter}`);
          argv.push('--exclude-dir=.git', '--exclude-dir=node_modules');
        }
        argv.push(pattern, searchPath);
        runGrepLike(argv, limit, resolveP);
      });
      probe.on('error', () => {
        const argv = ['grep', '-rn'];
        if (caseInsensitive) argv.push('-i');
        if (fixed) argv.push('-F');
        if (ctx > 0) argv.push('-C', String(ctx));
        if (globFilter) argv.push(`--include=${globFilter}`);
        argv.push('--exclude-dir=.git', '--exclude-dir=node_modules');
        argv.push(pattern, searchPath);
        runGrepLike(argv, limit, resolveP);
      });
    });
  }

  /**
   * `fs glob <pattern...> [--folder=DIR] [--exclude=PAT...]`
   * Multi-pattern OR via fast-glob.
   */
  private async handleFsGlob(req: WsRpcRequest): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const args = (req.parsed?.args ?? {}) as Record<string, unknown>;
    const rawPatterns: string[] = (() => {
      const p = args.patterns;
      if (typeof p === 'string' && p.trim()) {
        const s = p.trim();
        if (s.startsWith('[')) {
          try {
            const arr = JSON.parse(s) as unknown;
            if (Array.isArray(arr)) return arr.map(String);
          } catch { /* fall through */ }
        }
        return s.split(',').map((q) => q.trim()).filter(Boolean);
      }
      const pos1 = strArg(args, 'positional');
      const pos2 = strArg(args, 'positional2');
      const list: string[] = [];
      if (pos1) list.push(pos1);
      if (pos2) list.push(pos2);
      return list;
    })();
    if (rawPatterns.length === 0) {
      return { stdout: '', stderr: '[fs glob] at least one pattern is required', exitCode: 2 };
    }
    const folder = resolveUserPath(strArg(args, 'folder'), true, this.workingDirectory);
    const ignore: string[] = (() => {
      const base = ['**/node_modules/**', '**/.git/**'];
      const ex = args.exclude;
      if (typeof ex === 'string' && ex.trim()) {
        const s = ex.trim();
        if (s.startsWith('[')) {
          try {
            const arr = JSON.parse(s) as unknown;
            if (Array.isArray(arr)) return [...base, ...arr.map(String)];
          } catch { /* fall through */ }
        }
        return [...base, ...s.split(',').map((q) => q.trim()).filter(Boolean)];
      }
      return base;
    })();
    try {
      const files = await fg(rawPatterns, {
        cwd: folder,
        ignore,
        dot: true,
        onlyFiles: true,
        absolute: false,
        suppressErrors: true,
      });
      files.sort();
      const limit = 100;
      if (files.length === 0) return { stdout: 'No files found', stderr: '', exitCode: 0 };
      const truncated = files.length > limit;
      const shown = truncated ? files.slice(0, limit) : files;
      const header = `Found ${files.length} file(s) under ${folder}`;
      const tail = truncated ? '\n[results truncated; refine pattern]' : '';
      return { stdout: `${header}\n${shown.join('\n')}${tail}`, stderr: '', exitCode: 0 };
    } catch (err) {
      return { stdout: '', stderr: `[fs glob] ${(err as Error).message}`, exitCode: 1 };
    }
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void {
    if (this.opts.log) { this.opts.log(level, msg, meta); return; }
    const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
    if (level === 'error') console.error(`[rpc] ${line}`);
    else if (level === 'warn') console.warn(`[rpc] ${line}`);
    else console.log(`[rpc] ${line}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Local helpers (module-private)
// ──────────────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
  return /[\s'"`$\\]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
}

function unwrapSingleQuotedShellLine(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) return trimmed;

  let escaped = false;
  for (let i = 1; i < trimmed.length - 1; i++) {
    const ch = trimmed[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === quote) return trimmed;
  }
  return trimmed.slice(1, -1);
}

async function walkTree(dir: string, depth: number, prefix: string, out: string[]): Promise<void> {
  if (depth <= 0) return;
  let entries: import('fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    out.push(`${prefix}[error: ${(err as Error).message}]`);
    return;
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const last = i === entries.length - 1;
    const branch = last ? '└── ' : '├── ';
    const next = last ? '    ' : '│   ';
    out.push(`${prefix}${branch}${e.name}${e.isDirectory() ? '/' : ''}`);
    if (e.isDirectory()) {
      await walkTree(join(dir, e.name), depth - 1, prefix + next, out);
    }
  }
}

function runGrepLike(
  argv: string[],
  limit: number,
  resolveP: (r: { stdout: string; stderr: string; exitCode: number }) => void,
): void {
  const proc = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (b) => { stdout += b.toString('utf-8'); });
  proc.stderr.on('data', (b) => { stderr += b.toString('utf-8'); });
  proc.on('close', (exitCode) => {
    // grep / rg exit 1 when there are no matches — that's success for us.
    const noMatches = exitCode === 1 && !stdout.trim();
    if (noMatches) {
      resolveP({ stdout: 'No matches found', stderr: '', exitCode: 0 });
      return;
    }
    if (exitCode !== 0 && exitCode !== 1) {
      resolveP({ stdout: '', stderr: stderr || `[fs grep] exit ${exitCode}`, exitCode: exitCode ?? 1 });
      return;
    }
    const lines = stdout.split('\n');
    if (lines.length > limit) {
      const head = lines.slice(0, limit).join('\n');
      resolveP({
        stdout: `${head}\n\n[showing ${limit} of ${lines.length} lines; raise --limit or narrow the search]`,
        stderr: '',
        exitCode: 0,
      });
      return;
    }
    resolveP({ stdout: stdout.trim() || 'No matches found', stderr: '', exitCode: 0 });
  });
  proc.on('error', (err) => {
    resolveP({ stdout: '', stderr: `[fs grep] spawn ${argv[0]}: ${err.message}`, exitCode: 1 });
  });
}
