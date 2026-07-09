import React from 'react';
import { Box, Text, Static } from 'ink';
import { Markdown } from './Markdown.js';
import { ToolResult } from './ToolResult.js';
import { Spinner } from './Spinner.js';
import { Banner } from './Banner.js';
import { ToolStatusDot } from './ToolStatusDot.js';

// Sentinel: a synthetic "banner" item we inject as element 0 of the
// Static stream so the YOME logo gets committed to scrollback BEFORE
// any real message and never moves afterward. We tag it with a unique
// id well outside the regular message id range so partitionMessages
// can never collide.
type StaticItem = Message | { __banner: true; id: -1 };

// How long a just-completed tool_start keeps animating in the live
// region before it gets committed to <Static>. Must be >= the total
// duration of ToolStatusDot's fade sequence so the last transition
// frame has time to render before the row freezes.
const TRANSITION_HOLD_MS = 800;

export interface Message {
  type: 'user' | 'text' | 'tool_start' | 'tool_result' | 'error';
  content: string;
  toolName?: string;
  toolSummary?: string;
  toolLabel?: string;
  done?: boolean;
  /** Stable monotonic id assigned at push time. Required for <Static> keys. */
  id?: number;
}

export function getToolLabel(name: string): string {
  const labels: Record<string, string> = {
    Read: 'Read 1 file',
    Write: 'Write file',
    Edit: 'Edit file',
    Bash: 'Run command',
    Glob: 'Find files',
    Grep: 'Search files',
    LS: 'List directory',
  };
  return labels[name] ?? name;
}

export function getToolDetail(name: string, input: Record<string, unknown>): string {
  const keys: Record<string, string> = {
    Bash: 'command', Read: 'file_path', Write: 'file_path',
    Edit: 'file_path', Glob: 'pattern', Grep: 'pattern',
  };
  const key = keys[name];
  if (key) return String(input[key] || '');
  if (name === 'LS') return String(input.path || process.cwd());
  return JSON.stringify(input).slice(0, 60);
}

// ── Performance: memoized item renderer ──────────────────────────────
//
// Without memo, every streamText delta forces every historical row to
// re-render. Memo + stable props (msg ref unchanged once pushed) means
// React skips reconciling the bulk of the tree on each token.
const MessageItem = React.memo(function MessageItem({ msg }: { msg: Message }): React.ReactElement | null {
  switch (msg.type) {
    case 'user':
      return (
        <Box marginTop={1} borderStyle="single" borderLeft borderTop={false} borderBottom={false} borderRight={false} borderColor="#E87B35">
          <Text backgroundColor="black" color="#E87B35" bold>{' ' + msg.content + ' '}</Text>
        </Box>
      );

    case 'text':
      return (
        <Box marginTop={1} marginLeft={2} flexShrink={1} flexDirection="column">
          <Markdown>{msg.content}</Markdown>
        </Box>
      );

    case 'tool_start':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text>{'  '}</Text>
            <ToolStatusDot done={!!msg.done} />
            <Text> </Text>
            <Text bold>{msg.toolLabel}</Text>
          </Box>
          {msg.toolSummary && (
            <Box>
              <Text dimColor>{'    \u21B3 '}</Text>
              <Text dimColor>{msg.toolSummary}</Text>
            </Box>
          )}
        </Box>
      );

    case 'tool_result':
      return <ToolResult name={msg.toolName || ''} result={msg.content} />;

    case 'error':
      return (
        <Box>
          <Text dimColor>{'  \u21B3 '}</Text>
          <Text color="red">{msg.content}</Text>
        </Box>
      );

    default:
      return null;
  }
}, (prev, next) => {
  // Messages are immutable once pushed (we replace, not mutate). So
  // reference equality is a safe shortcut. The only mutating field is
  // `done` on tool_start when a result lands — that produces a NEW
  // object via spread, so ref check still catches it.
  return prev.msg === next.msg;
});

interface MessageListProps {
  messages: Message[];
  streamText: string;
  isRunning: boolean;
  /**
   * Bumped by App.tsx whenever the conversation is reset (e.g. `/new` or
   * session restore). We forward it onto Ink's <Static> via the `key` prop
   * below — Ink's Static buffer is append-only and never drops items
   * already committed to scrollback, so without remounting the user would
   * still see the previous chat after typing /new.
   */
  resetEpoch?: number;
}

// ── Static + live split ──────────────────────────────────────────────
//
// Strategy mirrors what Claude Code does with Ink:
//   - Completed messages go into <Static>. Ink renders them ONCE and
//     never re-renders them — they're committed to the scrollback
//     buffer above the live region. This is the single biggest win
//     for long sessions.
//   - The bottom "live" region (currently-streaming text + spinners)
//     re-renders every token, but it's small and bounded.
//
// A message is considered "stable" when it's not the tail of an open
// tool_start chain and there's no streaming text mutating below it.
// In practice we mark every message stable except the last `tool_start`
// without a paired result — those still flicker their spinner.
//
// To keep <Static> keys stable across renders we assign each message an
// `id` at push time (App.tsx). If an older message's `done` flag flips
// from false→true we want it to leave the live region and re-mount in
// Static cleanly, so we partition every render.
function partitionMessages(
  messages: Message[],
  doneAt: Map<number, number>,
  now: number,
): { staticMsgs: Message[]; liveMsgs: Message[] } {
  // A message is "live" if:
  //   - it's a tool_start that hasn't completed yet, OR
  //   - it's a tool_start that JUST completed (within TRANSITION_HOLD_MS)
  //     so ToolStatusDot gets to play its fade animation before the row
  //     is frozen into <Static>.
  //
  // Everything else (user text, assistant text, tool_result, error) is
  // stable immediately.
  const staticMsgs: Message[] = [];
  const liveMsgs: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.type !== 'tool_start') {
      staticMsgs.push(m);
      continue;
    }
    if (!m.done) {
      liveMsgs.push(m);
      continue;
    }
    const ts = m.id !== undefined ? doneAt.get(m.id) : undefined;
    if (ts !== undefined && now - ts < TRANSITION_HOLD_MS) {
      liveMsgs.push(m);
    } else {
      staticMsgs.push(m);
    }
  }
  return { staticMsgs, liveMsgs };
}

export const MessageList = React.memo(function MessageList({ messages, streamText, isRunning, resetEpoch = 0 }: MessageListProps) {
  // Track when each tool_start first transitions to done so partition
  // can hold it in the live region long enough for ToolStatusDot to
  // finish its fade. The ref survives re-renders; we also schedule a
  // follow-up render when the hold window expires.
  const doneAtRef = React.useRef<Map<number, number>>(new Map());
  const [, setTick] = React.useState(0);

  const now = Date.now();
  let earliestExpiry = Infinity;
  for (const m of messages) {
    if (m.type !== 'tool_start' || !m.done || m.id === undefined) continue;
    let ts = doneAtRef.current.get(m.id);
    if (ts === undefined) {
      ts = now;
      doneAtRef.current.set(m.id, ts);
    }
    const expiry = ts + TRANSITION_HOLD_MS;
    if (expiry > now && expiry < earliestExpiry) earliestExpiry = expiry;
  }

  React.useEffect(() => {
    if (earliestExpiry === Infinity) return;
    const t = setTimeout(() => setTick((n) => n + 1), earliestExpiry - Date.now());
    return () => clearTimeout(t);
  }, [earliestExpiry]);

  const { staticMsgs, liveMsgs } = partitionMessages(messages, doneAtRef.current, now);

  // Banner is item #0 of the Static stream, so Ink commits it to the
  // terminal once at boot — right after the user's `yome` command line
  // — and it stays anchored at that scrollback position forever. Every
  // real message is appended below it.
  const staticItems: StaticItem[] = React.useMemo(
    () => [{ __banner: true, id: -1 } as const, ...staticMsgs],
    [staticMsgs],
  );

  return (
    <>
      {/*
        Frozen scrollback — banner first, then completed messages.
        The `key` includes resetEpoch so `/new` (and session restore)
        force a fresh Static instance: Ink's Static is append-only and
        won't drop already-committed rows otherwise.
      */}
      <Static key={`static-${resetEpoch}`} items={staticItems}>
        {(item) => {
          if ('__banner' in item) {
            return <Banner key="banner" />;
          }
          return (
            <MessageItem key={item.id ?? `m-${item.content.slice(0, 16)}`} msg={item} />
          );
        }}
      </Static>

      {/* Live region — currently-running tools + streaming text. */}
      {liveMsgs.map((msg) => (
        <MessageItem key={msg.id ?? `live-${msg.toolName}`} msg={msg} />
      ))}

      {streamText && (
        <Box marginTop={1} marginLeft={2} flexShrink={1} flexDirection="column">
          <Markdown>{streamText}</Markdown>
        </Box>
      )}

      {isRunning && !streamText && liveMsgs.length === 0 && (
        <Box marginTop={1} marginLeft={2}>
          <Spinner />
          <Text dimColor>{' Thinking\u2026'}</Text>
        </Box>
      )}
    </>
  );
});
