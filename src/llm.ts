import type { YomeConfig } from './config.js';
import type { AgentMessage, AnthropicTool, AnthropicResponse, ContentBlock } from './types.js';
import { withRetry } from './withRetry.js';

type StreamCallback = (event: {
  type: 'text_delta' | 'tool_use_start' | 'tool_input_delta' | 'content_block_stop' | 'message_stop';
  text?: string;
  index?: number;
  toolUseId?: string;
  toolName?: string;
}) => void;

// Abort the stream when no SSE chunks have arrived for this long. Without
// this a silently half-closed TCP connection from the upstream gateway can
// hang the CLI indefinitely. Override via YOME_STREAM_IDLE_MS.
const STREAM_IDLE_MS = parseInt(process.env.YOME_STREAM_IDLE_MS ?? '', 10) || 60_000;
const STREAM_WARN_MS = Math.max(5_000, Math.floor(STREAM_IDLE_MS / 2));

class StreamIdleTimeoutError extends Error {
  constructor(ms: number) {
    super(`Stream idle timeout: no chunks received for ${Math.round(ms / 1000)}s`);
    this.name = 'StreamIdleTimeoutError';
  }
}

interface IdleWatchdog {
  signal: AbortSignal;
  reset: () => void;
  dispose: () => void;
}

function createIdleWatchdog(outerSignal?: AbortSignal): IdleWatchdog {
  const ctrl = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let warnTimer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (warnTimer) { clearTimeout(warnTimer); warnTimer = null; }
  };
  const reset = () => {
    clear();
    warnTimer = setTimeout(() => {
      console.warn(`[yome-llm] stream idle warning: no chunks for ${STREAM_WARN_MS / 1000}s`);
    }, STREAM_WARN_MS);
    idleTimer = setTimeout(() => {
      ctrl.abort(new StreamIdleTimeoutError(STREAM_IDLE_MS));
    }, STREAM_IDLE_MS);
  };
  const onOuterAbort = () => ctrl.abort(outerSignal?.reason ?? new Error('aborted'));
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort(outerSignal.reason);
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    reset,
    dispose: () => {
      clear();
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
    },
  };
}

// ── Context window management ───────────────────────────────────────
//
// As a session grows the message history is sent in full on every
// turn, blowing up upload bandwidth, latency, AND server-side context
// limits. Before serializing we trim middle messages, keeping:
//   - the first user turn (anchors the task)
//   - the most recent N turns (active context)
// Tool-use ↔ tool-result pairs are kept atomic so we never break the
// API contract that every tool_use needs its matching tool_result.
const MAX_KEEP_TAIL = parseInt(process.env.YOME_CONTEXT_TAIL_MESSAGES ?? '', 10) || 30;
const MAX_ANCHOR_TEXT_CHARS = 20_000;

function compactAnchorText(text: string): string {
  if (text.length <= MAX_ANCHOR_TEXT_CHARS) return text;
  return text.slice(0, MAX_ANCHOR_TEXT_CHARS) + `\n\n[Anchor message truncated at ${MAX_ANCHOR_TEXT_CHARS} chars]`;
}

function compactAnchorMessage(message: AgentMessage): AgentMessage {
  if (typeof message.content === 'string') {
    return { ...message, content: compactAnchorText(message.content) };
  }

  const compacted: ContentBlock[] = [];
  let omittedImages = 0;
  for (const block of message.content) {
    if (block.type === 'image') {
      omittedImages++;
      continue;
    }
    if (block.type === 'text') {
      compacted.push({ ...block, text: compactAnchorText(block.text) });
    } else if (block.type === 'tool_result') {
      compacted.push({ ...block, content: compactAnchorText(block.content) });
    } else {
      compacted.push(block);
    }
  }
  if (omittedImages > 0) {
    compacted.unshift({ type: 'text', text: `[${omittedImages} earlier image(s) omitted during context compaction]` });
  }
  return { ...message, content: compacted };
}

export function trimMessageHistory(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length <= MAX_KEEP_TAIL + 2) return messages;

  // Walk backward keeping at least MAX_KEEP_TAIL messages, but extend
  // the keep range if the cut would slice through a tool_use/tool_result
  // pair (assistant message with tool_use blocks → user message with
  // tool_result blocks should both stay or both go).
  let keepFrom = messages.length - MAX_KEEP_TAIL;
  // Pull back until we land on a clean boundary: a user text message
  // (not a tool_result wrapper) or the very start.
  while (keepFrom > 1) {
    const m = messages[keepFrom];
    const isToolResultMsg =
      m && m.role === 'user' && Array.isArray(m.content) &&
      m.content.some((b) => b.type === 'tool_result');
    if (!isToolResultMsg) break;
    keepFrom--;
  }
  if (keepFrom <= 1) return messages;

  // Always keep messages[0] (first user prompt) so the model has the
  // anchor task description.
  const head = compactAnchorMessage(messages[0]!);
  const tail = messages.slice(keepFrom);
  const droppedCount = keepFrom - 1;
  const elision: AgentMessage = {
    role: 'user',
    content: `[… ${droppedCount} earlier messages elided to fit the context window …]`,
  };
  return [head, elision, ...tail];
}

// HTTP layer is intentionally dumb now — retry lives in `withRetry`, which
// also understands stream-idle timeouts and network-layer errors that a
// status-code-only wrapper could never see.
async function postJson(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error ${response.status}: ${error}`);
  }
  return response;
}

// ── OpenAI-compatible format conversion ──

function toOpenAITools(tools: AnthropicTool[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function toOpenAIMessages(systemPrompt: string, messages: AgentMessage[]): unknown[] {
  const result: unknown[] = [{ role: 'system', content: systemPrompt }];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      const textParts = msg.content.filter((b) => b.type === 'text').map((b) => (b as any).text);
      const toolCalls = msg.content
        .filter((b) => b.type === 'tool_use')
        .map((b: any) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      const entry: any = { role: 'assistant' };
      entry.content = textParts.length > 0 ? textParts.join('\n') : null;
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      result.push(entry);
    } else {
      const toolResults = msg.content.filter((b) => b.type === 'tool_result');
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          result.push({
            role: 'tool',
            tool_call_id: (tr as any).tool_use_id,
            content: typeof (tr as any).content === 'string'
              ? (tr as any).content
              : JSON.stringify((tr as any).content),
          });
        }
      } else {
        const textParts = msg.content.filter((b) => b.type === 'text').map((b) => (b as any).text);
        const imageParts = msg.content.filter((b) => b.type === 'image');
        if (imageParts.length > 0) {
          const parts: unknown[] = [];
          for (const img of imageParts) {
            const src = (img as any).source;
            parts.push({
              type: 'image_url',
              image_url: { url: `data:${src.media_type};base64,${src.data}` },
            });
          }
          if (textParts.length > 0) {
            parts.push({ type: 'text', text: textParts.join('\n') });
          }
          result.push({ role: 'user', content: parts });
        } else {
          result.push({ role: 'user', content: textParts.join('\n') || '' });
        }
      }
    }
  }
  return result;
}

// ── OpenAI stream parser ──

async function callOpenAIStream(
  config: YomeConfig,
  systemPrompt: string,
  messages: AgentMessage[],
  tools: AnthropicTool[],
  onEvent: StreamCallback,
  signal?: AbortSignal,
): Promise<AnthropicResponse> {
  const trimmed = trimMessageHistory(messages);
  const body: Record<string, unknown> = {
    model: config.model ?? 'qwen-plus',
    max_tokens: 8192,
    stream: true,
    messages: toOpenAIMessages(systemPrompt, trimmed),
  };
  if (tools.length > 0) body.tools = toOpenAITools(tools);

  const watchdog = createIdleWatchdog(signal);
  try {
    const response = await postJson(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: watchdog.signal,
    });

    let textContent = '';
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let inputTokens = 0;
    let outputTokens = 0;

    watchdog.reset();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      watchdog.reset();
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(line.startsWith('data: ') ? 6 : 5).trim();
      if (data === '[DONE]') continue;

      let chunk: any;
      try { chunk = JSON.parse(data); } catch { continue; }

      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        textContent += delta.content;
        onEvent({ type: 'text_delta', text: delta.content });
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls.has(idx)) {
            toolCalls.set(idx, { id: tc.id || '', name: tc.function?.name || '', arguments: '' });
            if (tc.id) {
              onEvent({ type: 'tool_use_start', index: idx, toolUseId: tc.id, toolName: tc.function?.name });
            }
          }
          const existing = toolCalls.get(idx)!;
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
        }
      }
    }
  }

    onEvent({ type: 'message_stop' });

    const contentBlocks: ContentBlock[] = [];
    if (textContent) contentBlocks.push({ type: 'text', text: textContent });
    for (const [, tc] of toolCalls) {
      let parsedInput = {};
      try { parsedInput = JSON.parse(tc.arguments || '{}'); } catch { /* */ }
      contentBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parsedInput });
    }

    return {
      id: '',
      content: contentBlocks,
      stop_reason: toolCalls.size > 0 ? 'tool_use' : 'end_turn',
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  } finally {
    watchdog.dispose();
  }
}

// ── Anthropic stream parser ──

async function callAnthropicNativeStream(
  config: YomeConfig,
  systemPrompt: string,
  messages: AgentMessage[],
  tools: AnthropicTool[],
  onEvent: StreamCallback,
  signal?: AbortSignal,
): Promise<AnthropicResponse> {
  const trimmed = trimMessageHistory(messages);
  const body: Record<string, unknown> = {
    model: config.model ?? 'anthropic/claude-sonnet-4-20250514',
    max_tokens: 8192,
    stream: true,
    system: systemPrompt,
    messages: trimmed.map((m) => ({ role: m.role, content: m.content })),
  };
  if (tools.length > 0) body.tools = tools;

  const watchdog = createIdleWatchdog(signal);
  try {
    const response = await postJson(`${config.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: watchdog.signal,
    });

    const contentBlocks: ContentBlock[] = [];
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';
    let inputTokens = 0;
    let outputTokens = 0;
    const toolInputBuffers = new Map<number, { id: string; name: string; input: string }>();

    watchdog.reset();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      watchdog.reset();
      buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(line.startsWith('data: ') ? 6 : 5).trim();
      if (data === '[DONE]') continue;

      let event: any;
      try { event = JSON.parse(data); } catch { continue; }

      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block;
          if (block.type === 'text') {
            contentBlocks[event.index] = { type: 'text', text: '' };
          } else if (block.type === 'tool_use') {
            contentBlocks[event.index] = {
              type: 'tool_use', id: block.id, name: block.name, input: {},
            };
            toolInputBuffers.set(event.index, { id: block.id, name: block.name, input: '' });
            onEvent({ type: 'tool_use_start', index: event.index, toolUseId: block.id, toolName: block.name });
          }
          break;
        }
        case 'content_block_delta': {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            const block = contentBlocks[event.index];
            if (block?.type === 'text') block.text += delta.text;
            onEvent({ type: 'text_delta', text: delta.text, index: event.index });
          } else if (delta.type === 'input_json_delta') {
            const buf = toolInputBuffers.get(event.index);
            if (buf) buf.input += delta.partial_json;
          }
          break;
        }
        case 'content_block_stop': {
          const buf = toolInputBuffers.get(event.index);
          if (buf) {
            try {
              const block = contentBlocks[event.index];
              if (block?.type === 'tool_use') block.input = JSON.parse(buf.input || '{}');
            } catch { /* invalid JSON */ }
            toolInputBuffers.delete(event.index);
          }
          onEvent({ type: 'content_block_stop', index: event.index });
          break;
        }
        case 'message_delta': {
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          if (event.usage) outputTokens = event.usage.output_tokens;
          break;
        }
        case 'message_start': {
          if (event.message?.usage) inputTokens = event.message.usage.input_tokens;
          break;
        }
      }
    }
  }

    onEvent({ type: 'message_stop' });

    return {
      id: '',
      content: contentBlocks,
      stop_reason: stopReason,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  } finally {
    watchdog.dispose();
  }
}

// ── Public API: auto-routes by provider ──

export interface CallLLMOptions {
  signal?: AbortSignal;
  /** Forwarded to withRetry. Default 4 (= 5 total attempts). */
  maxRetries?: number;
  /** Fires before each backoff sleep so callers can surface a "retrying" toast. */
  onRetryNotice?: (n: { attempt: number; maxRetries: number; delayMs: number; error: string }) => void;
}

export function callLLMStream(
  config: YomeConfig,
  systemPrompt: string,
  messages: AgentMessage[],
  tools: AnthropicTool[],
  onEvent: StreamCallback,
  options: CallLLMOptions = {},
): Promise<AnthropicResponse> {
  return withRetry(
    () => {
      if (config.provider === 'openai') {
        return callOpenAIStream(config, systemPrompt, messages, tools, onEvent, options.signal);
      }
      return callAnthropicNativeStream(config, systemPrompt, messages, tools, onEvent, options.signal);
    },
    {
      signal: options.signal,
      maxRetries: options.maxRetries,
      label: config.provider === 'openai' ? 'cli-openai' : 'cli-anthropic',
      onRetryNotice: options.onRetryNotice,
    },
  );
}

export function callLLM(
  config: YomeConfig,
  systemPrompt: string,
  messages: AgentMessage[],
  tools: AnthropicTool[] = [],
  options: CallLLMOptions = {},
): Promise<AnthropicResponse> {
  const noop: StreamCallback = () => {};
  return callLLMStream(config, systemPrompt, messages, tools, noop, options);
}

export function extractText(response: AnthropicResponse): string {
  return response.content
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
