// Mesh wire-protocol types.
//
// Mirror of the relevant subset of `Server/agent/types.ts` so that
// cli ↔ PartyKit speak the same JSON frames as iOS / macOS already do.
// Kept manually-maintained (not generated) because cli is a separate npm
// package and we want this protocol surface to be stable + reviewable as
// part of the cli PR.

// ── Domain types ─────────────────────────────────────────────

export type CommandDomain =
  | 'bash' | 'sh' | 'fs' | 'git' | 'docker' | 'k8s' | 'systemd'
  | 'pkg' | 'log' | 'net' | 'svc'
  | 'cal' | 'rem' | 'note'
  | 'xl' | 'ppt' | 'doc' | 'kn' | 'num' | 'pg'
  | 'web' | 'mind' | 'term' | 'lark'
  | 'ps' | 'sp' | 'notif' | 'chat' | 'app' | 'cur' | 'cap' | 'wf' | 'watch';

// ── Frames sent FROM cli TO PartyKit ─────────────────────────

export interface WsDeviceRegister {
  type: 'mesh:register';
  hostname: string;
  model: string;
  platform?: string;
  capabilities: string[];
  installedApps: string[];
  workingDirectory?: string;
  alias?: string;
  deviceDescription?: string;
}

export interface WsDeviceUpdate {
  type: 'mesh:update-device';
  deviceId?: string;
  alias?: string;
  deviceDescription?: string;
}

export interface WsHeartbeat {
  type: 'mesh:heartbeat';
  deviceId: string;
}

export interface WsRpcResponse {
  type: 'rpc:cal-response';
  requestId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WsDeviceStatusResponse {
  type: 'device:status-response';
  requestId: string;
  runningApps?: string[];
  appWindows?: Array<{ app: string; documents: string[] }>;
}

export type WsClientFrame =
  | WsDeviceRegister
  | WsDeviceUpdate
  | WsHeartbeat
  | WsRpcResponse
  | WsDeviceStatusResponse;

// ── Frames received FROM PartyKit BY cli ─────────────────────

export interface WsConnected {
  type: 'connected';
  clientType: 'ios' | 'mac' | 'web' | 'desktop';
  userId: string;
}

export interface WsRpcRequest {
  type: 'rpc:cal-request';
  requestId: string;
  command: string;
  parsed: {
    domain: CommandDomain;
    action: string;
    args: Record<string, string>;
  };
}

export interface WsRpcToolCall {
  type: 'rpc:tool-call';
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface WsDeviceStatusRequest {
  type: 'device:status-request';
  requestId: string;
}

export interface WsDeviceUpdated {
  type: 'device-updated';
  devices: Array<{
    deviceId: string;
    userId: string;
    hostname: string;
    model: string;
    platform?: string;
    status: 'online' | 'busy' | 'offline';
    capabilities: string[];
    installedApps: string[];
    workingDirectory?: string;
    currentTask?: string;
    lastHeartbeat: number;
    alias?: string;
    deviceDescription?: string;
  }>;
}

export type WsServerFrame =
  | WsConnected
  | WsRpcRequest
  | WsRpcToolCall
  | WsDeviceStatusRequest
  | WsDeviceUpdated
  | { type: string; [k: string]: unknown }; // unknown frames pass through

// ── Ticket exchange (hub /api/cli/mesh/ws-ticket) ────────────

export interface WsTicketRequest {
  deviceId: string;
  hostname: string;
  platform: 'linux' | 'darwin' | 'win32' | string;
  /** Optional cli version string for hub-side analytics. */
  cliVersion?: string;
}

export interface WsTicketResponse {
  ok: boolean;
  /** Short-lived JWT (HS256 by Supabase JWT secret), sub=userId, aud=partykit. */
  ws_token: string;
  /** Seconds until ws_token expires. */
  expires_in: number;
  userId: string;
  deviceId: string;
  /** Host + room hint. e.g. "yome.party.yome.work". Room id is userId. */
  partykit_host: string;
  error?: string;
  code?: string;
}
