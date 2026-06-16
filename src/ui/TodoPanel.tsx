// cli/src/ui/TodoPanel.tsx
//
// Compact, always-visible task list. Sits between the message log and
// the InputBar. Renders nothing when there are no todos, so an idle
// session has zero visual noise.
//
// Visual idiom: a single orange left rule, no surrounding box. Same
// shape as the user-message echo in MessageList.tsx — the orange bar
// is the project's signal for "this is yome talking, not the user".
// The in_progress item shows a Spinner driven by the shared frame
// ticker so it pulses in lock step with the streaming spinners above.

import React from 'react';
import { Box, Text } from 'ink';
import { Spinner } from './Spinner.js';
import type { TodoItem } from '../state/todos.js';
import { theme } from './theme.js';

interface TodoPanelProps {
  todos: TodoItem[];
}

const MAX_VISIBLE = 8;

export const TodoPanel = React.memo(function TodoPanel({ todos }: TodoPanelProps) {
  if (todos.length === 0) return null;

  const counts = { completed: 0, in_progress: 0, pending: 0 };
  for (const t of todos) counts[t.status]++;

  const visible = todos.slice(0, MAX_VISIBLE);
  const hidden = todos.length - visible.length;

  return (
    <Box
      marginTop={1}
      paddingLeft={1}
      borderStyle="single"
      borderLeft
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      borderColor={theme.accent}
      flexDirection="column"
    >
      <Box>
        <Text bold color={theme.accent}>Todos</Text>
        <Text dimColor>
          {`  ·  ${counts.completed}✓  ${counts.in_progress}▶  ${counts.pending}○`}
        </Text>
      </Box>
      {visible.map((t, i) => {
        const key = `${i}-${t.content}`;
        if (t.status === 'completed') {
          return (
            <Box key={key}>
              <Text dimColor>{'✓ '}</Text>
              <Text dimColor strikethrough>{t.content}</Text>
            </Box>
          );
        }
        if (t.status === 'in_progress') {
          return (
            <Box key={key}>
              <Spinner color={theme.accent} />
              <Text color={theme.accent} bold>{' ' + t.activeForm}</Text>
            </Box>
          );
        }
        return (
          <Box key={key}>
            <Text dimColor>{'○ '}</Text>
            <Text>{t.content}</Text>
          </Box>
        );
      })}
      {hidden > 0 && (
        <Box>
          <Text dimColor>… +{hidden} more</Text>
        </Box>
      )}
    </Box>
  );
});
