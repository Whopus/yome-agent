import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ThreadSummary } from '../mesh/thread-stream.js';

interface ThreadPickerProps {
  threads: ThreadSummary[];
  loading: boolean;
  error?: string;
  onSelect: (threadId: string | undefined) => void;
  onRefresh: () => void;
  onCancel: () => void;
}

const MAX_VISIBLE = 10;

interface PickerItem extends ThreadSummary {
  isNew?: boolean;
}

function formatDate(ms: number): string {
  const diffMin = Math.floor((Date.now() - ms) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ThreadPicker({ threads, loading, error, onSelect, onRefresh, onCancel }: ThreadPickerProps) {
  const [cursor, setCursor] = useState(0);
  const items = useMemo<PickerItem[]>(
    () => [{ id: '', title: 'New/default thread', updatedAt: Date.now(), isNew: true }, ...threads],
    [threads],
  );

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((prev) => (prev > 0 ? prev - 1 : items.length - 1));
    } else if (key.downArrow) {
      setCursor((prev) => (prev < items.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      const item = items[cursor];
      if (item) onSelect(item.isNew ? undefined : item.id);
    } else if (input === 'r' || input === 'R') {
      onRefresh();
    } else if (key.escape || (key.ctrl && (input === 'c' || input === 'C'))) {
      onCancel();
    }
  });

  const visibleStart = useMemo(() => {
    if (items.length <= MAX_VISIBLE) return 0;
    const half = Math.floor(MAX_VISIBLE / 2);
    let start = cursor - half;
    if (start < 0) start = 0;
    if (start + MAX_VISIBLE > items.length) start = items.length - MAX_VISIBLE;
    return start;
  }, [cursor, items.length]);
  const visibleItems = items.slice(visibleStart, visibleStart + MAX_VISIBLE);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="#E87B35">Threads</Text>
        <Text dimColor> - choose where this terminal should attach</Text>
      </Box>

      {loading && <Text dimColor>Loading threads...</Text>}
      {error && <Text color="red">{error}</Text>}

      {!loading && visibleStart > 0 && <Text dimColor>  ^ more</Text>}

      {!loading && visibleItems.map((thread, vi) => {
        const realIdx = visibleStart + vi;
        const focused = realIdx === cursor;
        const pointer = focused ? '>' : ' ';
        const title = thread.title?.trim() || '(untitled)';
        const clipped = title.length > 64 ? `${title.slice(0, 61)}...` : title;
        return (
          <Box key={`${thread.id || 'new'}-${realIdx}`} flexDirection="column">
            <Box>
              <Text color={focused ? '#E87B35' : undefined}>{pointer} </Text>
              <Text bold={thread.isNew} color={focused ? '#E87B35' : undefined}>{clipped}</Text>
            </Box>
            {!thread.isNew && (
              <Box>
                <Text>{'   '}</Text>
                <Text dimColor>{formatDate(thread.updatedAt)}</Text>
                <Text dimColor>{' - '}</Text>
                <Text dimColor>{thread.id.slice(0, 12)}</Text>
              </Box>
            )}
          </Box>
        );
      })}

      {!loading && visibleStart + MAX_VISIBLE < items.length && <Text dimColor>  v more</Text>}

      <Box marginTop={1}>
        <Text dimColor>Up/Down navigate  Enter attach  r refresh  Esc exit</Text>
      </Box>
    </Box>
  );
}
