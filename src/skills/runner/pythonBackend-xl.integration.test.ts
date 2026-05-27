import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dispatchPython, probePythonBackendSync } from './pythonBackend.js';

const skillDir = resolve(process.cwd(), '..', 'skills', 'yome-skill-xl');
const hasSkill = existsSync(join(skillDir, 'yome-skill.json'));
const hasPython = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0 ||
  spawnSync('python', ['--version'], { stdio: 'ignore' }).status === 0;
const probe = hasSkill && hasPython ? probePythonBackendSync(skillDir) : { ok: false, stderr: 'missing skill or python' };

let tmpRoot: string;
let originalStateHome: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'yome-xl-real-backend-test-'));
  originalStateHome = process.env.YOME_STATE_HOME;
  process.env.YOME_STATE_HOME = join(tmpRoot, 'state');
});

afterEach(() => {
  if (originalStateHome === undefined) delete process.env.YOME_STATE_HOME;
  else process.env.YOME_STATE_HOME = originalStateHome;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe.skipIf(!probe.ok)('python-openpyxl xl backend integration', () => {
  it('runs every supported file-backed xl action using signature-compatible syntax', async () => {
    const book = join(tmpRoot, 'book.xlsx');
    const copy = join(tmpRoot, 'book-copy.xlsx');
    const csv = join(tmpRoot, 'book.csv');

    await okCall('new', [book], { force: true });
    await okCall('books');
    await stdoutContains('sheets', [], {}, 'Sheet');
    await stdoutContains('info', [book], {}, '"sheets"');

    await okCall('set', ['A1'], { value: 'Name', type: 'text' });
    await okCall('set', ['B1'], { value: 'Qty', type: 'text' });
    await okCall('set', ['A2'], { value: '贴片', type: 'text' });
    await okCall('set', ['B2'], { value: '10000', type: 'number' });
    await stdoutContains('get', ['B2'], { format: 'raw' }, '10000');
    await stdoutContains('range', ['A1:B2'], {}, '贴片\t10000');
    await stdoutContains('used', [], {}, '"range": "A1:B2"');
    await stdoutContains('range', [book], { sheet: 'Sheet', range: 'A1:B2' }, '贴片\t10000');
    await stdoutContains('used', [book], { sheet: 'Sheet' }, '"range": "A1:B2"');
    await stdoutContains('find', ['贴片'], {}, 'A2\t贴片');

    await okCall('fill', ['A3:B4'], { values: '批次\\n1\t2' });
    await stdoutContains('range', ['A3:B4'], {}, '批次');
    await okCall('fmt', ['A1:B1'], { bold: true, bg: '#FFFF00', align: 'center', numfmt: '@', border: 'all' });
    await okCall('width', ['A'], { size: '22' });

    await okCall('row.add', ['3'], { count: '1' });
    await okCall('row.delete', ['3'], { count: '1' });
    await okCall('col.add', ['C'], { count: '1' });
    await okCall('col.delete', ['C'], { count: '1' });

    await okCall('merge', ['D1:E1']);
    await okCall('unmerge', ['D1:E1']);

    await okCall('sheet.add', [], { name: '计划' });
    await okCall('sheet', ['计划']);
    await okCall('set', ['计划@A1'], { value: 'Linux backend', type: 'text' });
    await stdoutContains('get', ['计划@A1'], { format: 'raw' }, 'Linux backend');
    await okCall('sheet.rename', ['计划'], { name: '执行' });
    await okCall('sheet', ['Sheet']);
    await okCall('sheet.delete', ['执行']);

    await okCall('save', [], { path: copy, force: true });
    expect(existsSync(copy)).toBe(true);
    await okCall('open', [copy]);
    await okCall('export', [], { format: 'csv', path: csv, force: true });
    expect(readFileSync(csv, 'utf-8')).toContain('贴片');
    await okCall('close');
  }, 30_000);
});

async function okCall(
  action: string,
  positionals: string[] = [],
  flags: Record<string, string | boolean | number | undefined> = {},
): Promise<string> {
  const r = await dispatchPython(skillDir, action, { positionals, flags, workingDirectory: tmpRoot });
  expect(r.exitCode, `${action}: ${r.stderr || r.stdout}`).toBe(0);
  return r.stdout;
}

async function stdoutContains(
  action: string,
  positionals: string[],
  flags: Record<string, string | boolean | number | undefined>,
  expected: string,
): Promise<void> {
  const stdout = await okCall(action, positionals, flags);
  expect(stdout).toContain(expected);
}
