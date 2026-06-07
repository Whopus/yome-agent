// PartyKit WebSocket client.
//
// Port of Yome/Shared/Sync/PartyKitClient.swift to Node. Behaviour
// matches the Swift client one-for-one so the Cloud sees no difference
// between a macOS device, an iOS device, and a Linux box:
//
//   - URL shape: wss://{host}/parties/main/{roomId}?type=...&userId=...
//                 &deviceId=...&token=...&locale=...
//   - Keep-alive: WS ping every 30s; receive-loop drives `isConnected`.
//   - Reconnect: exponential backoff capped at 30s, max 10 attempts,
//                resets on successful receive.
//   - All inbound messages emit `onMessage(text)`.
//
// Differs from Swift in:
//   - Uses `ws` npm package (works on Node ≥18 without DOM).
//   - Token is fetched lazily via the TicketCache so reconnects
//     after the ticket expires automatically mint a new one.

import WebSocket from 'ws';
import type { TicketCache } from './ticket.js';

export interface PartyKitClientOpts {
  ticketCache: TicketCache;
  /** Override at boot for staging / local dev. */
  partykitHostOverride?: string;
  /** Override at boot for staging / local dev. */
  roomIdOverride?: string;
  clientType?: 'desktop' | 'mac' | 'ios' | 'web';
  locale?: string;
  /** Test seam: inject a custom WebSocket factory. */
  wsFactory?: (url: string) => WebSocket;
  /** Inject a logger; defaults to console. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export type Listener = (frame: string) => void;

export class PartyKitClient {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private intentionalClose = false;
  private readonly listeners = new Set<Listener>();
  private onConnectCb: (() => void) | null = null;
  private onDisconnectCb: (() => void) | null = null;

  constructor(private opts: PartyKitClientOpts) {}

  onMessage(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onConnect(cb: () => void): void { this.onConnectCb = cb; }
  onDisconnect(cb: () => void): void { this.onDisconnectCb = cb; }

  async connect(): Promise<void> {
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    await this.establish();
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.ws) {
      try { this.ws.close(1000, 'client-shutdown'); } catch { /* ignore */ }
      this.ws = null;
    }
    this.isConnected = false;
  }

  /** Throws if not connected. Caller chooses to await or fire-and-forget. */
  async send(frame: string | object): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('PartyKit not connected');
    }
    const text = typeof frame === 'string' ? frame : JSON.stringify(frame);
    return new Promise<void>((resolve, reject) => {
      ws.send(text, (err) => err ? reject(err) : resolve());
    });
  }

  get connected(): boolean {
    return this.isConnected;
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void {
    if (this.opts.log) { this.opts.log(level, msg, meta); return; }
    const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
    if (level === 'error') console.error(`[mesh] ${line}`);
    else if (level === 'warn') console.warn(`[mesh] ${line}`);
    else console.log(`[mesh] ${line}`);
  }

  private async establish(): Promise<void> {
    let ticket;
    try {
      ticket = await this.opts.ticketCache.get();
    } catch (err) {
      this.log('error', 'Ticket mint failed; will retry', { err: (err as Error).message });
      this.scheduleReconnect();
      return;
    }

    const host = this.opts.partykitHostOverride ?? ticket.partykit_host;
    const room = this.opts.roomIdOverride ?? ticket.userId;
    const type = this.opts.clientType ?? 'desktop';
    const locale = this.opts.locale ?? 'zh';

    // Local `partykit dev` serves plain ws://, not wss://. We sniff the
    // host so the same override works for staging (wss) and dev (ws).
    const isLocal = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|10\.|192\.168\.)/.test(host);
    const scheme = isLocal ? 'ws' : 'wss';
    const url =
      `${scheme}://${host}/parties/main/${encodeURIComponent(room)}` +
      `?type=${encodeURIComponent(type)}` +
      `&userId=${encodeURIComponent(ticket.userId)}` +
      `&deviceId=${encodeURIComponent(ticket.deviceId)}` +
      `&token=${encodeURIComponent(ticket.ws_token)}` +
      `&locale=${encodeURIComponent(locale)}`;

    const ws = this.opts.wsFactory ? this.opts.wsFactory(url) : new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.log('info', 'WS open', { host, room });
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.startPing();
      this.onConnectCb?.();
    });

    ws.on('message', (raw) => {
      // Per protocol the server always sends text frames; tolerate
      // binary just in case (decode as utf-8).
      const text = typeof raw === 'string'
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString('utf-8')
          : Buffer.from(raw as ArrayBuffer).toString('utf-8');
      for (const cb of this.listeners) {
        try { cb(text); } catch (err) { this.log('error', 'listener threw', { err: (err as Error).message }); }
      }
    });

    ws.on('close', (code, reasonBuf) => {
      this.log('warn', 'WS close', { code, reason: reasonBuf?.toString() ?? '' });
      this.cleanupSocket();
      if (!this.intentionalClose) {
        // 4001 = invalid token (see Server/party/yome.ts). Invalidate the
        // ticket cache before reconnecting so we re-mint a fresh one.
        if (code === 4001) this.opts.ticketCache.invalidate();
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      this.log('error', 'WS error', { err: err.message });
      // Don't tear down here; the 'close' handler runs on its own and
      // owns the reconnect path. ws guarantees 'close' fires after 'error'.
    });
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try { ws.ping(); } catch { /* ignore */ }
    }, 30_000);
  }

  private cleanupSocket(): void {
    const wasConnected = this.isConnected;
    this.isConnected = false;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.ws = null;
    if (wasConnected) this.onDisconnectCb?.();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('error', 'Max reconnect attempts reached; giving up');
      return;
    }
    this.reconnectAttempts += 1;
    const delaySec = Math.min(Math.pow(2, this.reconnectAttempts), 30);
    this.log('info', `Reconnecting in ${delaySec}s (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Async fire-and-forget; errors flow back into ws 'error'/'close'.
      void this.establish();
    }, delaySec * 1000);
  }
}
