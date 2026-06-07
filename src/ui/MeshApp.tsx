// MeshApp — Ink TUI that participates in a Yome thread as a thin client.
//
// This is the cli analogue of macOS Yome.app / iOS Yome's chat surface:
//   - it owns NO local agent loop
//   - it does NO LLM call
//   - every keystroke that "submits" becomes a `{type:'message'}` ws frame
//   - every render comes from PartyKit-broadcast events
//
// Mounted by `yome mesh start --tui`: the mesh daemon is already running
// (PartyKitClient + DeviceRegistrar + RpcHandler), so we just plug a
// ThreadStream into the same client.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { MessageList, getToolLabel, getToolDetail } from './MessageList.js';
import type { Message } from './MessageList.js';
import { InputBar } from './InputBar.js';
import { ThreadPicker } from './ThreadPicker.js';
import { ThreadStream } from '../mesh/thread-stream.js';
import type { ThreadEvent, ThreadSummary } from '../mesh/thread-stream.js';
import type { MeshDaemon } from '../mesh/index.js';

interface MeshAppProps {
  daemon: MeshDaemon;
  /** Override initial thread (e.g. resume). Otherwise server picks. */
  initialThreadId?: string;
}

let _msgIdSeq = 0;
const nextMsgId = (): number => ++_msgIdSeq;

export function MeshApp({ daemon, initialThreadId }: MeshAppProps): React.ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamText, setStreamText] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [threadId, setThreadId] = useState<string | undefined>(initialThreadId);
  const [threadPickerOpen, setThreadPickerOpen] = useState(!initialThreadId);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(!initialThreadId);
  const [threadListError, setThreadListError] = useState<string | undefined>();
  const [deviceCount, setDeviceCount] = useState(0);

  // Stable references across renders.
  const streamRef = useRef<ThreadStream | null>(null);
  const threadIdRef = useRef<string | undefined>(initialThreadId);
  const threadPickerOpenRef = useRef(!initialThreadId);
  const awaitingThreadSyncRef = useRef(false);
  // Buffer in-flight text deltas keyed by runId so concurrent runs
  // (rare but possible if the user has 2 threads open via iOS) don't
  // smear into each other.
  const liveTextByRunRef = useRef<Map<string, { msgId: number; text: string }>>(new Map());
  // Tool-use id -> message id so a later `agent:tool-result` can
  // mutate the right tool_start row (mark `done: true`).
  const toolMsgIdByUseRef = useRef<Map<string, number>>(new Map());

  const pushMessage = useCallback((msg: Message) => {
    const m: Message = { ...msg, id: msg.id ?? nextMsgId() };
    setMessages((prev) => [...prev, m]);
    return m.id!;
  }, []);

  const markToolDone = useCallback((toolUseId: string) => {
    const msgId = toolMsgIdByUseRef.current.get(toolUseId);
    if (msgId == null) return;
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, done: true } : m)));
  }, []);

  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);
  useEffect(() => { threadPickerOpenRef.current = threadPickerOpen; }, [threadPickerOpen]);

  const requestThreadList = useCallback(() => {
    setThreadsLoading(true);
    setThreadListError(undefined);
    const attempt = (n: number) => {
      const stream = streamRef.current;
      if (!stream) {
        if (n < 20) setTimeout(() => attempt(n + 1), 250);
        return;
      }
      stream.requestThreadList()
        .then(() => { /* thread:list event clears loading */ })
        .catch((err) => {
          if (n < 20) {
            setTimeout(() => attempt(n + 1), 250);
          } else {
            setThreadsLoading(false);
            setThreadListError(`failed to load threads: ${(err as Error).message}`);
          }
        });
    };
    attempt(0);
  }, []);

  const isForCurrentThread = (event: ThreadEvent): boolean => {
    const evThread = (event as { threadId?: unknown }).threadId;
    if (typeof evThread !== 'string') return false;
    return evThread === threadIdRef.current;
  };

  const upsertThread = useCallback((summary: ThreadSummary) => {
    setThreads((prev) => {
      const idx = prev.findIndex((t) => t.id === summary.id);
      const next = [...prev];
      if (idx >= 0) next[idx] = { ...next[idx], ...summary };
      else next.push(summary);
      next.sort((a, b) => b.updatedAt - a.updatedAt);
      return next;
    });
  }, []);

  const handleEvent = useCallback((event: ThreadEvent) => {
    switch (event.type) {
      case 'thread:list': {
        const list = Array.isArray((event as { threads?: unknown }).threads)
          ? (event as { threads: ThreadSummary[] }).threads
          : [];
        setThreads([...list].sort((a, b) => b.updatedAt - a.updatedAt));
        setThreadsLoading(false);
        setThreadListError(undefined);
        return;
      }

      case 'thread:sync': {
        const next = (event as { threadId?: string }).threadId;
        if (typeof next === 'string') {
          awaitingThreadSyncRef.current = false;
          streamRef.current?.setThreadId(next);
          setThreadId(next);
          upsertThread({ id: next, title: null, updatedAt: Date.now() });
        }
        return;
      }

      case 'thread:created': {
        const next = (event as { threadId?: string }).threadId;
        const title = (event as { title?: string }).title ?? null;
        if (typeof next === 'string') {
          upsertThread({ id: next, title, updatedAt: Date.now() });
          if (awaitingThreadSyncRef.current && !threadIdRef.current && !threadPickerOpenRef.current) {
            awaitingThreadSyncRef.current = false;
            streamRef.current?.setThreadId(next);
            setThreadId(next);
          }
        }
        return;
      }

      case 'thread:user-message': {
        if (!isForCurrentThread(event)) return;
        // Echo of another device sending a user-message into this
        // thread (e.g. iOS user typed). The server already excludes the
        // sending connection, so seeing this here means "someone else
        // talked".
        const content = String((event as { content?: unknown }).content ?? '');
        if (content) pushMessage({ type: 'user', content });
        return;
      }

      case 'agent:start': {
        if (!isForCurrentThread(event)) return;
        setIsRunning(true);
        return;
      }

      case 'agent:user-message': {
        // Server-confirmed user message (echoed back including our own).
        // We rely on `thread:user-message` for cross-device echoes and
        // do NOT also render this — otherwise users see duplicates.
        return;
      }

      case 'agent:text-delta': {
        if (!isForCurrentThread(event)) return;
        const { runId, delta } = event as { runId: string; delta?: string };
        if (!delta) return;
        const buf = liveTextByRunRef.current.get(runId);
        if (!buf) {
          const id = nextMsgId();
          liveTextByRunRef.current.set(runId, { msgId: id, text: delta });
          setStreamText(delta);
        } else {
          buf.text += delta;
          setStreamText(buf.text);
        }
        return;
      }

      case 'agent:text-done': {
        if (!isForCurrentThread(event)) return;
        const { runId, fullText, text } = event as { runId: string; fullText?: string; text?: string };
        const buf = liveTextByRunRef.current.get(runId);
        const final = fullText ?? text ?? buf?.text ?? '';
        if (final) {
          pushMessage({ type: 'text', content: final, id: buf?.msgId });
        }
        liveTextByRunRef.current.delete(runId);
        setStreamText('');
        return;
      }

      case 'agent:tool-use': {
        if (!isForCurrentThread(event)) return;
        const { toolUseId, name, input } = event as {
          toolUseId: string;
          name: string;
          input: Record<string, unknown>;
        };
        const id = nextMsgId();
        toolMsgIdByUseRef.current.set(toolUseId, id);
        const label = getToolLabel(name);
        const summary = getToolDetail(name, input ?? {});
        pushMessage({
          type: 'tool_start',
          content: '',
          toolName: name,
          toolLabel: label,
          toolSummary: summary,
          done: false,
          id,
        });
        return;
      }

      case 'agent:tool-result': {
        if (!isForCurrentThread(event)) return;
        const { toolUseId, exitCode, result } = event as {
          toolUseId: string;
          exitCode: number;
          result?: string;
        };
        markToolDone(toolUseId);
        const name = (() => {
          // Recover tool name from the matching tool_start row to keep
          // ToolResult formatting consistent.
          const msgId = toolMsgIdByUseRef.current.get(toolUseId);
          if (msgId == null) return '';
          const m = (messagesRef.current ?? []).find((mm) => mm.id === msgId);
          return m?.toolName ?? '';
        })();
        if (result) {
          pushMessage({ type: 'tool_result', toolName: name, content: result });
        }
        if (exitCode !== 0) {
          pushMessage({ type: 'error', content: `tool exited ${exitCode}` });
        }
        toolMsgIdByUseRef.current.delete(toolUseId);
        return;
      }

      case 'agent:done': {
        if (!isForCurrentThread(event)) return;
        setIsRunning(false);
        return;
      }

      case 'agent:error': {
        if (!isForCurrentThread(event)) return;
        const msg = String((event as { message?: unknown }).message ?? 'unknown error');
        pushMessage({ type: 'error', content: msg });
        setIsRunning(false);
        setStreamText('');
        return;
      }

      case 'agent:retry': {
        if (!isForCurrentThread(event)) return;
        // Surface as a dim hint, not a hard error.
        const attempt = (event as { attempt?: number }).attempt;
        pushMessage({ type: 'error', content: `(retrying${attempt ? ` #${attempt}` : ''}…)` });
        return;
      }

      case 'agent:quota-exceeded': {
        if (!isForCurrentThread(event)) return;
        const reason = String((event as { reason?: unknown }).reason ?? 'quota exceeded');
        pushMessage({ type: 'error', content: `quota: ${reason}` });
        setIsRunning(false);
        return;
      }

      case 'device-updated': {
        const devs = (event as { devices?: unknown[] }).devices ?? [];
        setDeviceCount(Array.isArray(devs) ? devs.length : 0);
        return;
      }

      default:
        return;
    }
  }, [pushMessage, markToolDone, upsertThread]);

  // Keep a ref to the latest messages so the tool-result handler above
  // can look up the matching tool_start name without re-binding the
  // event callback on every state change.
  const messagesRef = useRef<Message[]>(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    const stream = new ThreadStream({
      client: daemon.client,
      initialThreadId,
    });
    stream.start();
    const off = stream.on(handleEvent);
    streamRef.current = stream;
    if (!initialThreadId) requestThreadList();
    return () => {
      off();
      stream.stop();
      streamRef.current = null;
    };
  }, [daemon, initialThreadId, handleEvent, requestThreadList]);

  const handleThreadSelect = useCallback((nextThreadId: string | undefined) => {
    awaitingThreadSyncRef.current = nextThreadId === undefined;
    streamRef.current?.setThreadId(nextThreadId);
    setThreadId(nextThreadId);
    setThreadPickerOpen(false);
    setMessages([]);
    setStreamText('');
    setIsRunning(false);
  }, []);

  const handleSubmit = useCallback(async (raw: string) => {
    const value = raw.trim();
    if (!value || threadPickerOpenRef.current) return;
    setInputValue('');
    pushMessage({ type: 'user', content: value });
    setIsRunning(true);
    if (!threadIdRef.current) awaitingThreadSyncRef.current = true;
    try {
      await streamRef.current?.sendUserMessage(value);
    } catch (err) {
      pushMessage({ type: 'error', content: `send failed: ${(err as Error).message}` });
      setIsRunning(false);
    }
  }, [pushMessage]);

  // Ctrl-C twice or `/exit` to leave. First Ctrl-C clears input; second
  // exits. Matches what App.tsx does so muscle memory survives.
  const ctrlCRef = useRef<number>(0);
  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === 'C')) {
      const now = Date.now();
      if (now - ctrlCRef.current < 1500 || inputValue.length === 0) {
        exit();
        return;
      }
      ctrlCRef.current = now;
      setInputValue('');
    }
  });

  const loopName = threadId ? `mesh • ${threadId.slice(0, 8)}` : 'mesh';
  const banner = threadPickerOpen
    ? 'choose a thread'
    : `${deviceCount > 0 ? `${deviceCount} devices online` : 'connecting...'}`;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color="#E87B35" bold>Yome mesh </Text>
        <Text dimColor>— {banner}</Text>
      </Box>
      {threadPickerOpen ? (
        <ThreadPicker
          threads={threads}
          loading={threadsLoading}
          error={threadListError}
          onSelect={handleThreadSelect}
          onRefresh={requestThreadList}
          onCancel={exit}
        />
      ) : (
        <>
          <MessageList
            messages={messages}
            streamText={streamText}
            isRunning={isRunning}
          />
          <InputBar
            value={inputValue}
            onChange={setInputValue}
            onSubmit={handleSubmit}
            loopName={loopName}
          />
        </>
      )}
    </Box>
  );
}
