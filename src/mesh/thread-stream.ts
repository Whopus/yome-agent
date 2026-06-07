// Thread event stream — typed wrapper over PartyKitClient for the TUI.
//
// PartyKit broadcasts the canonical thread/agent event protocol (see
// Server/party/yome.ts handleUserMessage + YomeAgentRuntime). This
// module is the read/write surface the TUI uses to participate as a
// thin client, identical to how iOS / macOS Yome.app participate:
//
//   incoming (subscribe):
//     thread:sync            { threadId }
//     thread:list            { threads: [...] }
//     thread:created         { threadId, title }
//     thread:user-message    { threadId, content, imageURLs?, ... }
//     agent:start            { runId, agentType, sessionId? }
//     agent:user-message     { runId, content }
//     agent:text-delta       { runId, delta, agentType }
//     agent:text-done        { runId, text? / fullText? }
//     agent:tool-use         { runId, toolUseId, name, input }
//     agent:tool-result      { runId, toolUseId, exitCode, result? }
//     agent:done             { runId }
//     agent:error            { runId, message }
//     agent:retry            { runId, attempt }
//     agent:quota-exceeded   { runId, reason, ... }
//     device-updated         { devices: [...] }
//
//   outgoing (publish):
//     { type: 'message', content, threadId?, ... }   // user types a line
//
// The cli stays Stage A's bash/fs RPC executor _while also_ being a
// chat client — both directions share the same WS via PartyKitClient,
// because that's exactly how iOS Yome.app does it.

import type { PartyKitClient } from './partykit-client.js';

export type ThreadEvent =
  | { type: 'connected'; clientType?: string; userId?: string }
  | { type: 'thread:list'; threads: ThreadSummary[] }
  | { type: 'thread:sync'; threadId: string }
  | { type: 'thread:created'; threadId: string; title?: string }
  | { type: 'thread:user-message'; threadId: string; content: string; imageURLs?: string[] }
  | { type: 'agent:start'; runId: string; agentType?: string; sessionId?: string; threadId?: string }
  | { type: 'agent:user-message'; runId: string; content: string; threadId?: string }
  | { type: 'agent:text-delta'; runId: string; delta: string; agentType?: string; threadId?: string }
  | { type: 'agent:text-done'; runId: string; text?: string; fullText?: string; threadId?: string }
  | { type: 'agent:tool-use'; runId: string; toolUseId: string; name: string; input: Record<string, unknown>; threadId?: string }
  | { type: 'agent:tool-result'; runId: string; toolUseId: string; exitCode: number; result?: string; threadId?: string }
  | { type: 'agent:done'; runId: string; threadId?: string }
  | { type: 'agent:error'; runId: string; message: string; threadId?: string }
  | { type: 'agent:retry'; runId: string; attempt?: number; threadId?: string }
  | { type: 'agent:quota-exceeded'; runId: string; reason: string; threadId?: string }
  | { type: 'device-updated'; devices: Array<Record<string, unknown>> }
  | { type: string; [k: string]: unknown };

export type ThreadEventHandler = (event: ThreadEvent) => void;

export interface ThreadSummary {
  id: string;
  title: string | null;
  updatedAt: number;
}

export interface ThreadStreamOpts {
  client: PartyKitClient;
  /** Initial thread id (if resuming). Otherwise the first `thread:sync` wins. */
  initialThreadId?: string;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export class ThreadStream {
  private readonly client: PartyKitClient;
  private readonly handlers = new Set<ThreadEventHandler>();
  private currentThreadId: string | undefined;
  private unsubscribe: (() => void) | null = null;
  private readonly log: NonNullable<ThreadStreamOpts['log']>;

  constructor(opts: ThreadStreamOpts) {
    this.client = opts.client;
    this.currentThreadId = opts.initialThreadId;
    this.log = opts.log ?? (() => {});
  }

  /** Begin dispatching ws frames to subscribers. Safe to call multiple times. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.client.onMessage((frame) => this.handleFrame(frame));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.handlers.clear();
  }

  /** Subscribe to all thread/agent events. Returns an unsubscribe fn. */
  on(handler: ThreadEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  get threadId(): string | undefined {
    return this.currentThreadId;
  }

  setThreadId(threadId: string | undefined): void {
    this.currentThreadId = threadId;
  }

  async requestThreadList(): Promise<void> {
    await this.client.send({ type: 'thread:list' });
  }

  /**
   * Send a chat message as if it were typed in iOS / macOS Yome.app.
   * The server treats the connection's authenticated userId as the
   * sender; no extra identity bookkeeping needed here.
   *
   * If we don't yet have a threadId, omit it: the server will create or
   * resolve the default thread, then broadcast `thread:sync` which we
   * latch onto in handleFrame.
   */
  async sendUserMessage(content: string, opts?: { threadTitle?: string }): Promise<void> {
    const frame: Record<string, unknown> = {
      type: 'message',
      content,
    };
    if (this.currentThreadId) frame.threadId = this.currentThreadId;
    if (opts?.threadTitle) frame.threadTitle = opts.threadTitle;
    await this.client.send(frame);
  }

  private handleFrame(text: string): void {
    let parsed: ThreadEvent;
    try {
      parsed = JSON.parse(text) as ThreadEvent;
    } catch {
      // Non-JSON frames (e.g. ping/pong text) — ignore.
      return;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return;

    // Latch threadId from the authoritative server sync frame so the
    // next user message round-trips cleanly. Do not latch thread:created:
    // the room broadcasts thread creation for every thread, including
    // threads this TUI is not attached to.
    if (parsed.type === 'thread:sync' && typeof (parsed as { threadId?: unknown }).threadId === 'string') {
      this.currentThreadId = (parsed as { threadId: string }).threadId;
    }

    for (const h of this.handlers) {
      try { h(parsed); } catch (err) { this.log('error', 'ThreadStream handler threw', { err: (err as Error).message }); }
    }
  }
}
