import React from 'react';
import { Box, Text, Static } from 'ink';
import { Markdown } from './Markdown.js';
import { ToolResult } from './ToolResult.js';
import { Spinner } from './Spinner.js';
import { Banner } from './Banner.js';
import { theme } from './theme.js';

// Sentinel: a synthetic "banner" item we inject as element 0 of the
// Static stream so the YOME logo gets committed to scrollback BEFORE
// any real message and never moves afterward. We tag it with a unique
// id well outside the regular message id range so partitionMessages
// can never collide.
type StaticItem = Message | { __banner: true; id: -1 };

const DOT = process.platform === 'darwin' ? '\u23FA' : '\u25CF';

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
        <Box marginTop={1} borderStyle="single" borderLeft borderTop={false} borderBottom={false} borderRight={false} borderColor={theme.accent}>
          <Text backgroundColor="black" color={theme.accent} bold>{' ' + msg.content + ' '}</Text>
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
            {!msg.done && <Spinner color={theme.accent} />}
            {msg.done && <Text color={theme.accent}>{DOT}</Text>}
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
function partitionMessages(messages: Message[]): { staticMsgs: Message[]; liveMsgs: Message[] } {
  // A message is "live" if it's a tool_start that hasn't completed yet.
  // Everything else (including tool_result, text, user, error) is stable
  // and can be committed to <Static>.
  //
  // We also keep the very last message in the live region so its initial
  // mount animation (e.g. a final assistant text) doesn't get suppressed
  // by Static's "render once" semantics on the first frame.
  const staticMsgs: Message[] = [];
  const liveMsgs: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const isOpenTool = m.type === 'tool_start' && !m.done;
    if (isOpenTool) {
      liveMsgs.push(m);
    } else {
      staticMsgs.push(m);
    }
  }
  return { staticMsgs, liveMsgs };
}

export const MessageList = React.memo(function MessageList({ messages, streamText, isRunning, resetEpoch = 0 }: MessageListProps) {
  const { staticMsgs, liveMsgs } = partitionMessages(messages);

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
