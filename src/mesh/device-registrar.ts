// Send mesh:register + mesh:heartbeat to the PartyKit room.
//
// Port of Yome/Shared/Sync/DeviceRegistrar.swift. Behaviour:
//   - On connect: send mesh:register {hostname, model, capabilities, ...}.
//   - Every 30s: send mesh:heartbeat {deviceId}.
//   - On reconnect: re-send register (room may have evicted the stale
//                   entry while we were down).
//   - On alias / description change: send mesh:update-device.

import { detectCapabilities } from './capabilities.js';
import { getOrCreateDeviceId, getModelString, loadDeviceState, safeHostname } from './device-id.js';
import type { PartyKitClient } from './partykit-client.js';
import type { WsDeviceRegister, WsDeviceUpdate, WsHeartbeat } from './types.js';

export interface RegistrarOpts {
  /** Override hostname (useful for `yome mesh start --as <name>`). */
  hostnameOverride?: string;
  /** Directory where the mesh session was launched. */
  workingDirectory?: string;
  /** Optional log hook. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

export class DeviceRegistrar {
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private detachConnect: (() => void) | null = null;
  private detachDisconnect: (() => void) | null = null;
  private readonly deviceId: string;
  private readonly hostname: string;
  private readonly model: string;
  private readonly workingDirectory: string;
  private capabilities: string[];

  constructor(private client: PartyKitClient, private opts: RegistrarOpts = {}) {
    this.deviceId = getOrCreateDeviceId();
    this.hostname = opts.hostnameOverride ?? safeHostname();
    this.model = getModelString();
    this.workingDirectory = opts.workingDirectory ?? process.cwd();
    this.capabilities = detectCapabilities();
  }

  getDeviceId(): string { return this.deviceId; }
  getHostname(): string { return this.hostname; }
  getCapabilities(): string[] { return [...this.capabilities]; }

  start(): void {
    // Initial registration if we're already connected (caller's choice;
    // usually they connect first, then call start()).
    if (this.client.connected) {
      void this.sendRegistration();
      this.scheduleHeartbeat();
    }
    // On every (re)connect, push registration again. Stash the off-handles
    // so stop() can detach.
    const noopDetach = () => {};
    this.detachConnect = noopDetach; // overridden below if we wire onConnect
    this.client.onConnect(() => {
      this.log('info', 'PartyKit connected — sending registration', {
        deviceId: this.deviceId, capabilities: this.capabilities,
      });
      void this.sendRegistration();
      this.scheduleHeartbeat();
    });
    this.client.onDisconnect(() => {
      this.log('warn', 'PartyKit disconnected — pausing heartbeat');
      this.clearHeartbeat();
    });
  }

  stop(): void {
    this.clearHeartbeat();
    this.detachConnect?.();
    this.detachDisconnect?.();
    this.detachConnect = null;
    this.detachDisconnect = null;
  }

  async sendRegistration(): Promise<void> {
    const state = loadDeviceState();
    const frame: WsDeviceRegister = {
      type: 'mesh:register',
      hostname: this.hostname,
      model: this.model,
      platform: process.platform,
      capabilities: this.capabilities,
      installedApps: [], // Linux has no app-bundle concept; capabilities cover it
      workingDirectory: this.workingDirectory,
      ...(state?.alias ? { alias: state.alias } : {}),
      ...(state?.description ? { deviceDescription: state.description } : {}),
    };
    try {
      await this.client.send(frame);
    } catch (err) {
      this.log('error', 'sendRegistration failed', { err: (err as Error).message });
    }
  }

  /** Apply local metadata update + push mesh:update-device. */
  async sendDeviceMetaUpdate(meta: { alias?: string; description?: string }): Promise<void> {
    const frame: WsDeviceUpdate = {
      type: 'mesh:update-device',
      deviceId: this.deviceId,
      ...(meta.alias !== undefined ? { alias: meta.alias } : {}),
      ...(meta.description !== undefined ? { deviceDescription: meta.description } : {}),
    };
    try {
      // Server expects register first, then update (see Swift comment in
      // DeviceRegistrar.sendDeviceMetaUpdate). Honour the same ordering.
      await this.sendRegistration();
      await new Promise((r) => setTimeout(r, 200));
      await this.client.send(frame);
    } catch (err) {
      this.log('error', 'sendDeviceMetaUpdate failed', { err: (err as Error).message });
    }
  }

  private scheduleHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const frame: WsHeartbeat = { type: 'mesh:heartbeat', deviceId: this.deviceId };
      // Fire-and-forget; PartyKitClient will surface fatal errors via
      // its own 'close' handler.
      void this.client.send(frame).catch(() => { /* ignore transient send errors */ });
    }, HEARTBEAT_INTERVAL_MS);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void {
    if (this.opts.log) { this.opts.log(level, msg, meta); return; }
    const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
    if (level === 'error') console.error(`[registrar] ${line}`);
    else if (level === 'warn') console.warn(`[registrar] ${line}`);
    else console.log(`[registrar] ${line}`);
  }
}
