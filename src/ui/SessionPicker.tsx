import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SessionInfo } from '../sessions.js';
import { PickerKeyHint } from './PickerKeyHint.js';

interface SessionPickerProps {
  sessions: SessionInfo[];
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}

const MAX_VISIBLE = 8;

function formatDate(d: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function SessionPicker({ sessions, onSelect, onCancel }: SessionPickerProps) {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((prev) => (prev > 0 ? prev - 1 : sessions.length - 1));
    } else if (key.downArrow) {
      setCursor((prev) => (prev < sessions.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      if (sessions[cursor]) onSelect(sessions[cursor].sessionId);
    } else if (key.escape || (key.ctrl && input === 'c')) {
      onCancel();
    }
  });

  const visibleStart = useMemo(() => {
    if (sessions.length <= MAX_VISIBLE) return 0;
    const half = Math.floor(MAX_VISIBLE / 2);
    let start = cursor - half;
    if (start < 0) start = 0;
    if (start + MAX_VISIBLE > sessions.length) start = sessions.length - MAX_VISIBLE;
    return start;
  }, [cursor, sessions.length]);

  const visibleItems = sessions.slice(visibleStart, visibleStart + MAX_VISIBLE);
  const hasScrollUp = visibleStart > 0;
  const hasScrollDown = visibleStart + MAX_VISIBLE < sessions.length;

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>No previous sessions found for this project.</Text>
        <Box marginTop={1}>
          <Text dimColor>Esc to close</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="#E87B35">Sessions</Text>
        <Text dimColor> {'\u2014'} {sessions.length} session{sessions.length !== 1 ? 's' : ''}, select to continue</Text>
      </Box>

      {hasScrollUp && (
        <Box>
          <Text dimColor>  {'\u2191'} more</Text>
        </Box>
      )}

      {visibleItems.map((s, vi) => {
        const realIdx = visibleStart + vi;
        const isFocused = realIdx === cursor;
        const pointer = isFocused ? '\u276F' : ' ';
        const titleText = s.title.length > 60 ? s.title.slice(0, 57) + '...' : s.title;
        const timeStr = formatDate(s.lastModified);

        return (
          <Box key={s.sessionId} flexDirection="column">
            <Box>
              <Text color={isFocused ? '#E87B35' : undefined}>{pointer} </Text>
              <Text bold color={isFocused ? '#E87B35' : undefined}>{titleText}</Text>
            </Box>
            <Box>
              <Text>{'   '}</Text>
              <Text dimColor>{timeStr}</Text>
              <Text dimColor>{' \u00B7 '}</Text>
              <Text dimColor>{s.messageCount} messages</Text>
            </Box>
          </Box>
        );
      })}

      {hasScrollDown && (
        <Box>
          <Text dimColor>  {'\u2193'} more</Text>
        </Box>
      )}

      <PickerKeyHint
        hints={[
          { keys: '\u2191\u2193', label: 'nav' },
          { keys: 'Enter', label: 'continue' },
          { keys: 'Esc', label: 'close' },
        ]}
      />
    </Box>
  );
}
