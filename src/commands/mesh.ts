// `yome mesh ...` subcommand router.

import { existsSync, readFileSync, unlinkSync, writeFileSync, openSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn, execSync } from 'child_process';
import { startMeshDaemon } from '../mesh/index.js';
import { getOrCreateDeviceId, loadDeviceState, safeHostname, updateDeviceMeta } from '../mesh/device-id.js';
import { detectCapabilities } from '../mesh/capabilities.js';
import { readAuthState } from '../yomeSkills/auth.js';

const MESH_ROOT = join(homedir(), '.yome', 'mesh');
const MESH_PID = join(MESH_ROOT, 'mesh.pid');
const MESH_STDOUT = join(MESH_ROOT, 'mesh.stdout.log');
const MESH_STDERR = join(MESH_ROOT, 'mesh.stderr.log');

export interface MeshCliFlags {
  foreground?: boolean;
  follow?: boolean;
  as?: string;
  hubBase?: string;
  /**
   * `yome mesh start --tui` mounts an Ink-based thin-client UI on top
   * of the running mesh daemon. The daemon continues to serve RPCs in
   * the background; the TUI just subscribes to the same WS as a chat
   * surface (so iOS / macOS messages stream into the terminal in
   * real time, and lines typed at the prompt round-trip through Cloud).
   */
  tui?: boolean;
}

export async function runMeshSubcommand(args: string[], flags: MeshCliFlags): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case 'start':   return doStart(args.slice(1), flags);
    case 'stop':    return doStop();
    case 'restart': return doRestart(args.slice(1), flags);
    case 'status':  return doStatus();
    case 'logs':    return doLogs(flags);
    case 'rename':  return doRename(args.slice(1));
    case 'info':    return doInfo();
    case undefined:
    case 'help':
    case '--help':  printHelp(); return 0;
    default:
      console.error(`Unknown subcommand: yome mesh ${sub}`);
      printHelp();
      return 2;
  }
}

function printHelp(): void {
  console.log(`Usage: yome mesh <subcommand>

  start [--foreground]   Connect to Yome Cloud as a mesh device.
                         Without --foreground, runs detached in the background.
  start --tui            Same, but also mount a chat TUI in this terminal.
                         iOS / macOS messages stream into it live; lines you
                         type round-trip through Cloud. Forces foreground.
  stop                   Stop the running mesh daemon (SIGTERM).
  restart                Stop the running daemon and start a new one.
                         Useful after updating yome-cli via npm.
  status                 Show daemon pid + device id + capabilities.
  logs [-f]              Print mesh daemon log (use -f / --follow to tail).
  info                   Show device id, hostname, alias, detected capabilities.
  rename <alias> [desc]  Set this device's display alias + optional description.

Files:
  ~/.yome/device.json       persistent device id + metadata
  ~/.yome/auth.json         yome account token (set via yome login)
  ~/.yome/mesh/mesh.pid     pid of the running mesh daemon
  ~/.yome/mesh/mesh.*.log   mesh daemon stdout / stderr

Prereqs:
  Run \`yome login\` once on this box before \`yome mesh start\`.
`);
}

async function doStart(_pos: string[], flags: MeshCliFlags): Promise<number> {
  if (!readAuthState()) {
    console.error('✗ Not logged in. Run `yome login` first.');
    return 1;
  }
  // Foreground = the path systemd / launchd / `--foreground` from
  // an admin invokes; the daemon owns this process. The TUI flag also
  // forces foreground (Ink can only attach to a real TTY, not the
  // background log file we redirect into).
  if (flags.foreground || flags.tui) {
    return runForeground(flags);
  }
  // Detach a background child running ourselves in foreground.
  const existing = readPidIfRunning();
  if (existing) {
    console.error(`✗ yome mesh already running (pid=${existing})`);
    return 1;
  }
  ensureMeshRoot();
  const out = openSync(MESH_STDOUT, 'a');
  const err = openSync(MESH_STDERR, 'a');
  const child = spawn(process.execPath, [process.argv[1]!, 'mesh', 'start', '--foreground', ...(flags.as ? ['--as', flags.as] : [])], {
    detached: true,
    stdio: ['ignore', out, err],
  });
  child.unref();
  console.log(`✓ yome mesh launched in background`);
  console.log(`  logs: ${MESH_STDOUT}`);
  return 0;
}

async function runForeground(flags: MeshCliFlags): Promise<number> {
  const workingDirectory = process.cwd();
  // ensureMeshRoot first so MESH_PID has a parent dir; foreground path
  // can also be invoked directly (systemd / launchd) without the
  // background path creating ~/.yome/mesh/ for us.
  ensureMeshRoot();
  writeFileSync(MESH_PID, String(process.pid));
  let daemon: Awaited<ReturnType<typeof startMeshDaemon>> | null = null;
  let tuiUnmount: (() => void) | null = null;
  const teardown = () => {
    try { tuiUnmount?.(); } catch { /* ignore */ }
    try { daemon?.shutdown(); } catch { /* ignore */ }
    try { if (existsSync(MESH_PID)) unlinkSync(MESH_PID); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', teardown);
  process.on('SIGTERM', teardown);

  // Logger: if TUI is on, NEVER write to stdout (Ink owns the screen).
  // Tee everything to ~/.yome/mesh/mesh.tui.log instead so the user
  // can `tail -F` from another terminal.
  const tuiLogPath = join(MESH_ROOT, 'mesh.tui.log');
  const log = flags.tui
    ? (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void => {
        try {
          const line = `${new Date().toISOString()} [${level}] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`;
          appendFileSync(tuiLogPath, line);
        } catch { /* ignore */ }
      }
    : undefined;

  try {
    daemon = await startMeshDaemon({
      hubBase: flags.hubBase,
      asName: flags.as,
      workingDirectory,
      log,
    });
  } catch (err) {
    console.error(`✗ mesh start failed: ${(err as Error).message}`);
    try { if (existsSync(MESH_PID)) unlinkSync(MESH_PID); } catch { /* ignore */ }
    return 1;
  }

  if (flags.tui) {
    // Lazy-load Ink + MeshApp so non-TUI callers (systemd, background
    // detached child) never pay the React render cost or pull stdin.
    const { render } = await import('ink');
    const { default: React } = await import('react');
    const { MeshApp } = await import('../ui/MeshApp.js');
    const instance = render(React.createElement(MeshApp, { daemon }));
    tuiUnmount = () => instance.unmount();
    // Block on Ink's own lifecycle: when the user exits the TUI
    // (Ctrl-C in MeshApp -> useApp().exit()), waitUntilExit resolves.
    await instance.waitUntilExit();
    teardown();
    return 0;
  }

  // Headless: block forever; the daemon owns timers + WS.
  return new Promise<number>(() => { /* never resolves */ });
}

async function doRestart(pos: string[], flags: MeshCliFlags): Promise<number> {
  const pid = readPidIfRunning();
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`✓ sent SIGTERM to pid=${pid}`);
    } catch (e) {
      console.error(`✗ failed to stop old process: ${(e as Error).message}`);
      return 1;
    }
    // Wait for the old process to exit before starting a new one.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(r => setTimeout(r, 200));
    }
    // If still alive after 5s, bail out.
    try {
      process.kill(pid, 0);
      console.error(`✗ old process (pid=${pid}) did not exit in time`);
      return 1;
    } catch { /* exited, good */ }
    // Clean up stale pid file
    try { if (existsSync(MESH_PID)) unlinkSync(MESH_PID); } catch { /* ignore */ }
  } else {
    console.log('(yome mesh was not running, starting fresh)');
  }
  return doStart(pos, flags);
}

function doStop(): number {
  const pid = readPidIfRunning();
  if (!pid) { console.log('(yome mesh was not running)'); return 0; }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`✓ sent SIGTERM to pid=${pid}`);
    return 0;
  } catch (e) {
    console.error(`✗ failed to stop yome mesh: ${(e as Error).message}`);
    return 1;
  }
}

function doStatus(): number {
  const pid = readPidIfRunning();
  const deviceId = getOrCreateDeviceId();
  const state = loadDeviceState();
  const caps = detectCapabilities();
  if (!pid) {
    console.log('Status:        not running');
  } else {
    console.log(`Status:        running (pid=${pid})`);
  }
  console.log(`Device id:     ${deviceId}`);
  console.log(`Hostname:      ${safeHostname()}`);
  if (state?.alias) console.log(`Alias:         ${state.alias}`);
  if (state?.description) console.log(`Description:   ${state.description}`);
  console.log(`Capabilities:  ${caps.join(', ')}`);
  console.log(`PID file:      ${MESH_PID}`);
  console.log(`Logs:          ${MESH_STDOUT}`);
  return 0;
}

function doLogs(flags: MeshCliFlags): number {
  if (!existsSync(MESH_STDOUT) && !existsSync(MESH_STDERR)) {
    console.log('(no mesh logs yet — `yome mesh start` first)');
    return 0;
  }
  if (flags.follow) {
    try {
      execSync(`tail -F "${MESH_STDOUT}" "${MESH_STDERR}"`, { stdio: 'inherit' });
    } catch { /* user interrupted */ }
    return 0;
  }
  const tail = (file: string) => {
    if (!existsSync(file)) return;
    try {
      const buf = readFileSync(file, 'utf-8');
      const lines = buf.split('\n').slice(-100).join('\n');
      console.log(`── ${file} ──`);
      console.log(lines);
    } catch { /* ignore */ }
  };
  tail(MESH_STDOUT);
  tail(MESH_STDERR);
  return 0;
}

function doInfo(): number {
  const deviceId = getOrCreateDeviceId();
  const state = loadDeviceState();
  const caps = detectCapabilities();
  const auth = readAuthState();
  console.log(`Yome user:     ${auth?.yome_user_id ?? '(not logged in — run `yome login`)'}`);
  console.log(`Provider:      ${auth?.provider ?? '-'} (${auth?.provider_login ?? '-'})`);
  console.log(`Device id:     ${deviceId}`);
  console.log(`Hostname:      ${safeHostname()}`);
  console.log(`Created at:    ${state?.createdAt ?? '(this run)'}`);
  if (state?.alias) console.log(`Alias:         ${state.alias}`);
  if (state?.description) console.log(`Description:   ${state.description}`);
  console.log(`Capabilities:  ${caps.join(', ')}`);
  return 0;
}

function doRename(pos: string[]): number {
  const alias = pos[0];
  const description = pos.slice(1).join(' ').trim() || undefined;
  if (!alias) {
    console.error('Usage: yome mesh rename <alias> [description]');
    return 2;
  }
  const next = updateDeviceMeta({ alias, description });
  console.log(`✓ alias set to "${next.alias}"`);
  if (description) console.log(`  description: ${description}`);
  console.log('(restart `yome mesh` to push the new alias to Cloud)');
  return 0;
}

function ensureMeshRoot(): void {
  try {
    mkdirSync(MESH_ROOT, { recursive: true });
  } catch { /* ignore */ }
}

function readPidIfRunning(): number | null {
  if (!existsSync(MESH_PID)) return null;
  try {
    const pid = Number.parseInt(readFileSync(MESH_PID, 'utf-8').trim(), 10);
    if (!Number.isFinite(pid)) return null;
    // Signal 0 = liveness check.
    try { process.kill(pid, 0); } catch { return null; }
    return pid;
  } catch {
    return null;
  }
}
