// Generic OTA Python backend dispatcher for hub skills.
//
// Contract: the backend entry is a Python script that accepts:
//   <python> entry.py --probe
//   <python> entry.py --dispatch
//
// --probe prints JSON:    { ok, supports?, stderr? }
// --dispatch reads JSON:  { action, positionals, flags, workingDirectory }
//            prints JSON: { ok, stdout?, stderr?, exitCode? }

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readManifest } from '../../yomeSkills/manifest.js';
import type { DispatchResult } from './nodeBackend.js';

const PYTHON_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;

export interface PythonBackendRequest {
  action: string;
  positionals: string[];
  flags: Record<string, string | boolean | number | undefined>;
  workingDirectory?: string;
}

export interface PythonBackendResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface PythonProbeResult {
  ok: boolean;
  supports?: string[];
  stderr?: string;
  python?: string;
  entry?: string;
}

/** True when the skill ships a Python OTA backend entry the CLI can spawn. */
export function hasPythonBackend(skillDir: string): boolean {
  return resolvePythonEntry(skillDir) !== null;
}

export function probePythonBackendSync(skillDir: string): PythonProbeResult {
  const entry = resolvePythonEntry(skillDir);
  if (!entry) return { ok: false, stderr: 'no python backend entry found' };

  const python = resolvePythonInterpreter();
  if (!python) {
    return {
      ok: false,
      stderr: 'python backend requires python3 or python on PATH, or YOME_PYTHON=/path/to/python',
      entry,
    };
  }

  const r = spawnSync(python, [entry, '--probe'], {
    encoding: 'utf-8',
    timeout: PROBE_TIMEOUT_MS,
    env: process.env,
  });
  if (r.error) return { ok: false, stderr: r.error.message, python, entry };
  if (r.status !== 0) {
    return {
      ok: false,
      stderr: (r.stderr || r.stdout || `python backend probe exited ${r.status}`).trim(),
      python,
      entry,
    };
  }
  try {
    const parsed = JSON.parse((r.stdout || '').trim()) as PythonProbeResult;
    return { ...parsed, python, entry };
  } catch {
    return { ok: false, stderr: `python backend probe returned non-JSON: ${(r.stdout || '').trim()}`, python, entry };
  }
}

export async function dispatchPython(
  skillDir: string,
  action: string,
  call: {
    positionals: string[];
    flags: Record<string, string | boolean | number | undefined>;
    workingDirectory?: string;
  },
): Promise<DispatchResult> {
  const entry = resolvePythonEntry(skillDir);
  if (!entry) {
    return { ok: false, stdout: '', stderr: 'no python backend installed for this skill', exitCode: 2 };
  }
  const python = resolvePythonInterpreter();
  if (!python) {
    return {
      ok: false,
      stdout: '',
      stderr: 'python backend requires python3 or python on PATH, or YOME_PYTHON=/path/to/python',
      exitCode: 127,
    };
  }

  const workingDirectory = call.workingDirectory ?? process.cwd();
  const payload: PythonBackendRequest = {
    action,
    positionals: call.positionals,
    flags: call.flags,
    workingDirectory,
  };

  return await new Promise<DispatchResult>((resolveP) => {
    const proc = spawn(python, [entry, '--dispatch'], {
      cwd: workingDirectory,
      env: { ...process.env, YOME_WORKING_DIRECTORY: workingDirectory },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      resolveP({
        ok: false,
        stdout: '',
        stderr: `python backend timed out after ${PYTHON_TIMEOUT_MS / 1000}s`,
        exitCode: 124,
      });
    }, PYTHON_TIMEOUT_MS);

    proc.stdout.on('data', (b) => { stdout += b.toString('utf-8'); });
    proc.stderr.on('data', (b) => { stderr += b.toString('utf-8'); });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ ok: false, stdout: '', stderr: `python backend spawn error: ${err.message}`, exitCode: 1 });
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const raw = stdout.trim();
      if (!raw) {
        resolveP({ ok: false, stdout: '', stderr: stderr || `python backend exited ${code ?? 1} with no output`, exitCode: code ?? 1 });
        return;
      }
      let parsed: PythonBackendResult;
      try {
        parsed = JSON.parse(raw) as PythonBackendResult;
      } catch {
        resolveP({
          ok: false,
          stdout,
          stderr: stderr || `python backend returned non-JSON output`,
          exitCode: code ?? 1,
        });
        return;
      }
      resolveP({
        ok: !!parsed.ok,
        stdout: parsed.stdout ?? '',
        stderr: parsed.stderr ?? stderr,
        exitCode: parsed.exitCode ?? (parsed.ok ? 0 : (code ?? 1)),
      });
    });

    proc.stdin.end(JSON.stringify(payload));
  });
}

function resolvePythonEntry(skillDir: string): string | null {
  const manifest = readManifest(skillDir);
  if (!manifest) return null;
  const delivery = (manifest.delivery ?? {}) as Record<string, unknown>;
  const python = delivery.python as undefined | {
    backend?: string;
    package?: string;
    entry?: string;
  };
  if (!python) return null;
  if (python.backend && python.backend !== 'ota') return null;

  const pkg = typeof python.package === 'string' ? python.package : 'backends/python';
  const entry = typeof python.entry === 'string' ? python.entry : 'xl_backend.py';
  const baseAbs = isAbsolute(pkg) ? pkg : join(skillDir, pkg);
  const candidates = [
    join(baseAbs, entry),
    join(baseAbs, 'xl_backend.py'),
    join(baseAbs, 'main.py'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function resolvePythonInterpreter(): string | null {
  const candidates = [
    process.env.YOME_PYTHON,
    'python3',
    'python',
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);

  for (const bin of candidates) {
    const r = spawnSync(bin, ['--version'], {
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!r.error && r.status === 0) return bin;
  }
  return null;
}
