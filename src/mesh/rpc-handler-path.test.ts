// Regression tests for fs path resolution on Linux mesh.
//
// Background: thread-1779085552209-3246 session 2 — every `fs ls /uno`,
// `fs read ~/.bashrc`, etc. silently fell back to the daemon's cwd
// because handleFs only inspected `args.path`, not the bare positional
// produced by Server/agent/commandParser. We rewrote handleFs to share
// a single resolveUserPath helper; this file pins down its contract.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { RpcHandler } from './rpc-handler.js';
import { detectCapabilities } from './capabilities.js';
import type { PartyKitClient } from './partykit-client.js';
import type { WsRpcRequest, WsRpcResponse } from './types.js';

// Spin up a no-op fake client that captures the response so the test can
// assert on what the daemon would send back.
function fakeClient(): { sent: WsRpcResponse[]; client: PartyKitClient } {
  const sent: WsRpcResponse[] = [];
  const noop = (_: string) => () => { /* detach */ };
  const client = {
    onMessage: noop,
    send: async (frame: unknown) => {
      sent.push(frame as WsRpcResponse);
    },
  } as unknown as PartyKitClient;
  return { sent, client };
}

function makeReq(domain: string, action: string, args: Record<string, string> = {}): WsRpcRequest {
  return {
    type: 'rpc:cal-request',
    requestId: `req-${Math.random()}`,
    command: `${domain} ${action}`,
    parsed: { domain, action, args },
  } as WsRpcRequest;
}

// Drive a single request through the handler via its public WS hook.
// handleRequest is private, so we wire start() and feed a fake frame.
function dispatchOne(handler: RpcHandler, req: WsRpcRequest, sent: WsRpcResponse[]): Promise<WsRpcResponse> {
  return new Promise((resolve) => {
    // Poll the sent buffer.
    const id = req.requestId;
    const tick = () => {
      const hit = sent.find((r) => r.requestId === id);
      if (hit) resolve(hit);
      else setTimeout(tick, 5);
    };
    // Inject by calling the internal dispatch (we have access via the
    // private handleRequest indirectly through start(). Easier: call
    // the private method through casting — tests are allowed to.
    void (handler as unknown as { handleRequest: (r: WsRpcRequest) => Promise<void> })
      .handleRequest(req);
    tick();
  });
}

let tmpRoot: string;
let workspaceRoot: string;
let originalHome: string | undefined;
let originalCwd: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'yome-rpc-test-'));
  const workspacePath = join(tmpRoot, 'workspace');
  mkdirSync(workspacePath);
  workspaceRoot = realpathSync(workspacePath);
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  process.env.HOME = tmpRoot;
  process.chdir(workspaceRoot);
  // os.homedir() reads HOME on POSIX (or USERPROFILE on win32). We force HOME so
  // every "~" path in the test resolves into our sandbox tmp dir.
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('fs path resolution', () => {
  it('ls with bare positional resolves to the absolute path, not cwd', async () => {
    const target = join(tmpRoot, 'sub');
    mkdirSync(target);
    writeFileSync(join(target, 'a.txt'), 'a');
    writeFileSync(join(target, 'b.txt'), 'b');

    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const req = makeReq('fs', 'ls', { positional: target });
    const resp = await dispatchOne(handler, req, sent);

    expect(resp.exitCode).toBe(0);
    expect(resp.stdout).toContain('a.txt');
    expect(resp.stdout).toContain('b.txt');
    // Header for server-side compress() to see rows.
    expect(resp.stdout).toContain('name\ttype\tsize');
  });

  it('ls with ~ expands to $HOME', async () => {
    writeFileSync(join(tmpRoot, 'home-file.txt'), 'x');
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('fs', 'ls', { positional: '~' }), sent);
    expect(resp.exitCode).toBe(0);
    expect(resp.stdout).toContain('home-file.txt');
  });

  it('ls with ~/sub joins HOME', async () => {
    const sub = join(tmpRoot, 'config');
    mkdirSync(sub);
    writeFileSync(join(sub, 'app.yaml'), 'k: v');
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('fs', 'ls', { positional: '~/config' }), sent);
    expect(resp.exitCode).toBe(0);
    expect(resp.stdout).toContain('app.yaml');
  });

  it('ls with no path falls back to the mesh working directory', async () => {
    writeFileSync(join(workspaceRoot, 'fallback-marker.txt'), 'x');
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('fs', 'ls', {}), sent);
    expect(resp.exitCode).toBe(0);
    expect(resp.stdout).toContain('fallback-marker.txt');
  });

  it('relative paths resolve under the mesh working directory', async () => {
    const sub = join(workspaceRoot, 'src');
    mkdirSync(sub);
    writeFileSync(join(sub, 'index.ts'), 'export {}');
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('fs', 'ls', { positional: 'src' }), sent);
    expect(resp.exitCode).toBe(0);
    expect(resp.stdout).toContain(`${sub}:`);
    expect(resp.stdout).toContain('index.ts');
  });

  it('sh and legacy bash exec start in the mesh working directory', async () => {
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const shResp = await dispatchOne(handler, makeReq('sh', 'pwd'), sent);
    expect(shResp.exitCode).toBe(0);
    expect(shResp.stdout.trim()).toBe(workspaceRoot);

    const bashResp = await dispatchOne(handler, makeReq('bash', 'exec', { cmd: 'pwd' }), sent);
    expect(bashResp.exitCode).toBe(0);
    expect(bashResp.stdout.trim()).toBe(workspaceRoot);
  });

  it('read on a directory returns a non-EISDIR friendly hint', async () => {
    const sub = join(tmpRoot, 'adir');
    mkdirSync(sub);
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('fs', 'read', { positional: sub }), sent);
    expect(resp.exitCode).toBe(1);
    expect(resp.stderr).toMatch(/is a directory/);
    expect(resp.stderr).toContain('fs ls');
  });

  it('stat returns JSON with name+type+size+modifiedAt', async () => {
    const p = join(tmpRoot, 'a.txt');
    writeFileSync(p, 'hello');
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('fs', 'stat', { positional: p }), sent);
    expect(resp.exitCode).toBe(0);
    const o = JSON.parse(resp.stdout);
    expect(o.name).toBe('a.txt');
    expect(o.type).toBe('file');
    expect(o.size).toBe(5);
    expect(typeof o.modifiedAt).toBe('string');
  });

  it('head reads the first N lines', async () => {
    const p = join(tmpRoot, 'lines.txt');
    writeFileSync(p, ['a', 'b', 'c', 'd'].join('\n'));
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('fs', 'head', { positional: p, lines: '2' }), sent);
    expect(resp.exitCode).toBe(0);
    expect(resp.stdout).toBe('a\nb');
  });

  it('tail reads the last N lines', async () => {
    const p = join(tmpRoot, 'lines.txt');
    writeFileSync(p, ['a', 'b', 'c', 'd'].join('\n'));
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('fs', 'tail', { positional: p, lines: '2' }), sent);
    expect(resp.exitCode).toBe(0);
    expect(resp.stdout).toBe('c\nd');
  });

  it('find --name matches a recursive glob', async () => {
    mkdirSync(join(tmpRoot, 'src/deep'), { recursive: true });
    writeFileSync(join(tmpRoot, 'src/deep/needle.txt'), 'x');
    writeFileSync(join(tmpRoot, 'src/other.md'), 'x');
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('fs', 'find', { positional: tmpRoot, name: '*.txt' }), sent);
    expect(resp.exitCode).toBe(0);
    expect(resp.stdout).toContain('needle.txt');
    expect(resp.stdout).not.toContain('other.md');
    expect(resp.stdout.split('\n')[0]).toBe('path\tname');
  });

  it('tree shows nested entries with branch glyphs', async () => {
    mkdirSync(join(tmpRoot, 'a/b'), { recursive: true });
    writeFileSync(join(tmpRoot, 'a/b/c.txt'), '');
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('fs', 'tree', { positional: tmpRoot, depth: '3' }), sent);
    expect(resp.exitCode).toBe(0);
    expect(resp.stdout).toContain('a/');
    expect(resp.stdout).toContain('b/');
    expect(resp.stdout).toContain('c.txt');
  });

  it('unknown action returns a helpful message listing implemented actions', async () => {
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('fs', 'totally-fake'), sent);
    expect(resp.exitCode).toBe(127);
    expect(resp.stderr).toMatch(/unknown action: totally-fake/);
    expect(resp.stderr).toMatch(/ls,/);
    expect(resp.stderr).toMatch(/stat/);
  });

  it('mv moves a file', async () => {
    const a = join(tmpRoot, 'a.txt');
    const b = join(tmpRoot, 'b.txt');
    writeFileSync(a, 'hi');
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('fs', 'mv', { positional: a, to: b }), sent);
    expect(resp.exitCode).toBe(0);
    expect(() => writeFileSync(a, 'oops')).not.toThrow(); // a is gone, recreating ok
  });

  it('symlink is reported as type=link in ls', async () => {
    writeFileSync(join(tmpRoot, 'real.txt'), '');
    try {
      symlinkSync(join(tmpRoot, 'real.txt'), join(tmpRoot, 'link.txt'));
    } catch {
      return; // some CI envs forbid symlinks
    }
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('fs', 'ls', { positional: tmpRoot }), sent);
    expect(resp.exitCode).toBe(0);
    expect(resp.stdout).toMatch(/link\.txt\tlink/);
  });

  it('grep finds matches with positional pattern and ~ path', async () => {
    writeFileSync(join(tmpRoot, 'a.txt'), 'apple\nbanana\nneedle here\n');
    writeFileSync(join(tmpRoot, 'b.txt'), 'no match');
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('fs', 'grep', { positional: 'needle', positional2: '~' }), sent);
    expect(resp.exitCode).toBe(0);
    expect(resp.stdout).toContain('needle here');
  });
});

describe('routing', () => {
  it('advertises sh because the Linux mesh handler implements it', () => {
    expect(detectCapabilities()).toContain('sh');
  });

  it('unknown domain points the model at sh', async () => {
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('term', 'exec', { cmd: 'echo ok' }), sent);
    expect(resp.exitCode).toBe(127);
    expect(resp.stderr).toMatch(/unknown domain: term/);
    expect(resp.stderr).toMatch(/`sh /);
  });

  it('not-yet-implemented domain points the model at bash exec', async () => {
    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ } });
    const resp = await dispatchOne(handler, makeReq('docker', 'ps'), sent);
    expect(resp.exitCode).toBe(127);
    expect(resp.stderr).toMatch(/not implemented/);
    expect(resp.stderr).toMatch(/bash exec/);
  });

  it('routes xl through an installed skill backend with parsed positionals and flags', async () => {
    const skillDir = writeFakeXlSkill();
    writeFakeSkillIndex(skillDir);

    const { sent, client } = fakeClient();
    const handler = new RpcHandler(client, { log: () => { /* quiet */ }, workingDirectory: workspaceRoot });
    const resp = await dispatchOne(handler, makeReq('xl', 'ping', { positional: 'C3', value: 'ok' }), sent);

    expect(resp.exitCode).toBe(0);
    expect(resp.stdout).toContain('xl-python:ping:C3:ok');
  });
});

// Sanity check: helpers we rely on across the suite behave as expected.
describe('test environment', () => {
  it('HOME override resolves homedir() to the tmp dir', () => {
    expect(homedir()).toBe(tmpRoot);
    expect(isAbsolute(tmpRoot)).toBe(true);
  });
});

function writeFakeXlSkill(): string {
  const skillDir = join(tmpRoot, '.yome', 'skills', 'yome', 'xl');
  mkdirSync(join(skillDir, 'backends', 'python'), { recursive: true });
  writeFileSync(join(skillDir, 'yome-skill.json'), JSON.stringify({
    slug: '@yome/xl',
    domain: 'xl',
    version: '1.0.0',
    system_capabilities: [],
    delivery: {
      python: { backend: 'ota', package: 'backends/python', entry: 'backend.py' },
    },
    backends: {
      'python-openpyxl': { runtime: 'python', platforms: ['linux', 'macos', 'windows'], supports: ['ping'] },
    },
    adapters: {
      linux: { prefer: ['python-openpyxl'] },
      macos: { prefer: ['python-openpyxl'] },
      windows: { prefer: ['python-openpyxl'] },
    },
  }, null, 2));
  writeFileSync(join(skillDir, 'backends', 'python', 'backend.py'), [
    'import json, sys',
    'if "--probe" in sys.argv:',
    '    print(json.dumps({"ok": True, "supports": ["ping"]}))',
    'else:',
    '    req = json.load(sys.stdin)',
    '    pos = req["positionals"][0] if req["positionals"] else ""',
    '    value = req["flags"].get("value", "")',
    '    print(json.dumps({"ok": True, "stdout": f"xl-python:{req[\'action\']}:{pos}:{value}", "exitCode": 0}))',
    '',
  ].join('\n'));
  return skillDir;
}

function writeFakeSkillIndex(skillDir: string): void {
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
