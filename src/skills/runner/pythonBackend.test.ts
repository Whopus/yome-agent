import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchPython, hasPythonBackend, probePythonBackendSync } from './pythonBackend.js';
import { invokeSkill } from '../../yomeSkills/invoke.js';

const hasPython = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0 ||
  spawnSync('python', ['--version'], { stdio: 'ignore' }).status === 0;

let tmpRoot: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'yome-python-backend-test-'));
  originalHome = process.env.HOME;
  process.env.HOME = tmpRoot;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe.skipIf(!hasPython)('python backend runner', () => {
  it('probes and dispatches a manifest-declared python backend', async () => {
    const skillDir = writeFakeSkill('python-openpyxl');

    expect(hasPythonBackend(skillDir)).toBe(true);
    expect(probePythonBackendSync(skillDir).ok).toBe(true);

    const r = await dispatchPython(skillDir, 'ping', {
      positionals: ['A1'],
      flags: { value: '42' },
      workingDirectory: tmpRoot,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('python:ping:A1:42');
  });

  it('invokeSkill honors adapter preference and skips node stubs', async () => {
    const skillDir = writeFakeSkill('python-openpyxl');
    writeIndex(skillDir);

    const r = await invokeSkill({
      slugOrDomain: 'xl',
      action: 'ping',
      positionals: ['B2'],
      flags: { value: 'ok' },
      workingDirectory: tmpRoot,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('python:ping:B2:ok');
  });
});

function writeFakeSkill(preferred: string): string {
  const skillDir = join(tmpRoot, '.yome', 'skills', 'yome', 'xl');
  mkdirSync(join(skillDir, 'backends', 'python'), { recursive: true });
  mkdirSync(join(skillDir, 'backends', 'node', 'src'), { recursive: true });
  writeFileSync(join(skillDir, 'yome-skill.json'), JSON.stringify({
    slug: '@yome/xl',
    domain: 'xl',
    version: '1.0.0',
    system_capabilities: [],
    delivery: {
      python: { backend: 'ota', package: 'backends/python', entry: 'backend.py' },
      node: { backend: 'ota', package: 'backends/node', entry: 'src/index.ts' },
    },
    backends: {
      'python-openpyxl': { runtime: 'python', platforms: ['linux', 'macos', 'windows'], supports: ['ping'] },
      'node-ota': { runtime: 'node', status: 'stub', supports: [] },
    },
    adapters: {
      linux: { prefer: [preferred] },
      macos: { prefer: [preferred] },
      windows: { prefer: [preferred] },
    },
  }, null, 2));
  writeFileSync(join(skillDir, 'backends', 'python', 'backend.py'), [
    'import json, sys',
    'if "--probe" in sys.argv:',
    '    print(json.dumps({"ok": True, "supports": ["ping"]}))',
    'else:',
    '    req = json.load(sys.stdin)',
    '    value = req["flags"].get("value", "")',
    '    pos = req["positionals"][0] if req["positionals"] else ""',
    '    print(json.dumps({"ok": True, "stdout": f"python:{req[\'action\']}:{pos}:{value}", "exitCode": 0}))',
    '',
  ].join('\n'));
  writeFileSync(join(skillDir, 'backends', 'node', 'src', 'index.ts'), [
    'export async function dispatch() {',
    '  return { ok: false, stderr: "node stub should not run" };',
    '}',
    '',
  ].join('\n'));
  return skillDir;
}

function writeIndex(skillDir: string): void {
  const indexDir = join(tmpRoot, '.yome', 'skills');
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(join(indexDir, '.index.json'), JSON.stringify({
    version: 1,
    built_at: new Date(0).toISOString(),
    skills: [{
      slug: '@yome/xl',
      domain: 'xl',
      version: '1.0.0',
      installedAt: skillDir,
      status: 'enabled',
      is_dev_link: false,
      declared_capabilities: [],
      allowed_capabilities: [],
    }],
  }, null, 2));
}
