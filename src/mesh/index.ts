// Mesh subsystem entry point.
//
// Owns the lifetime of the PartyKit connection + DeviceRegistrar + RPC
// handler. Called by `yome mesh start --foreground` (and, indirectly,
// by the systemd unit installed via `yome daemon install` on Linux).

import { TicketCache, mintWsTicket } from './ticket.js';
import { PartyKitClient } from './partykit-client.js';
import { DeviceRegistrar } from './device-registrar.js';
import { RpcHandler } from './rpc-handler.js';
import { getOrCreateDeviceId, safeHostname } from './device-id.js';

export interface MeshDaemonOpts {
  /** Override hub URL (env YOME_HUB_BASE wins inside ticket.ts otherwise). */
  hubBase?: string;
  /** Optional PartyKit host override (staging / local dev). */
  partykitHost?: string;
  /** Hostname to advertise. Defaults to os.hostname(). */
  asName?: string;
  /** Directory where this mesh session should execute shell/fs commands. */
  workingDirectory?: string;
  /** Log sink; if omitted we use the built-in console logger. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export interface MeshDaemon {
  client: PartyKitClient;
  registrar: DeviceRegistrar;
  rpc: RpcHandler;
  shutdown: () => void;
}

/**
 * Start the mesh daemon. Resolves once the WS connection has been
 * INITIATED (not necessarily established); the registrar will (re)send
 * the registration once the WS open handler fires.
 *
 * Returns a `shutdown()` so the cli command runner can install signal
 * handlers (SIGINT / SIGTERM) that tear it down cleanly.
 */
export async function startMeshDaemon(opts: MeshDaemonOpts = {}): Promise<MeshDaemon> {
  const log = opts.log ?? defaultLog;
  const workingDirectory = opts.workingDirectory ?? process.cwd();
  log('info', 'Starting yome mesh', {
    deviceId: getOrCreateDeviceId(),
    hostname: opts.asName ?? safeHostname(),
    workingDirectory,
  });

  const ticketCache = new TicketCache(() => mintWsTicket({ hubBase: opts.hubBase }));
  // Warm the cache eagerly so a misconfigured hub fails fast with a
  // human-readable error, instead of inside the WS reconnect loop.
  const firstTicket = await ticketCache.get();
  log('info', 'Hub minted WS ticket', {
    userId: firstTicket.userId,
    deviceId: firstTicket.deviceId,
    expiresIn: firstTicket.expires_in,
    partykitHost: firstTicket.partykit_host,
  });

  // YOME_PARTYKIT_HOST env override lets us point a single binary at a
  // local `partykit dev` for end-to-end tests without redeploying.
  const partykitHostOverride = opts.partykitHost ?? process.env.YOME_PARTYKIT_HOST;
  if (partykitHostOverride && partykitHostOverride !== firstTicket.partykit_host) {
    log('info', 'PartyKit host override active', { override: partykitHostOverride });
  }

  const client = new PartyKitClient({
    ticketCache,
    partykitHostOverride,
    clientType: 'desktop',
    log,
  });

  const registrar = new DeviceRegistrar(client, {
    hostnameOverride: opts.asName,
    workingDirectory,
    log,
  });
  registrar.start();

  const rpc = new RpcHandler(client, { workingDirectory, log });
  rpc.start();

  await client.connect();

  return {
    client,
    registrar,
    rpc,
    shutdown: () => {
      rpc.stop();
      registrar.stop();
      client.disconnect();
    },
  };
}

function defaultLog(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void {
  const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
  const stamp = new Date().toISOString();
  const out = `${stamp} [${level}] ${line}`;
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
}
