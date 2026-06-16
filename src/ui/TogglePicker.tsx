import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from './theme.js';

export interface ToggleItem {
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  skills?: string[];
}

interface TogglePickerProps {
  title: string;
  items: ToggleItem[];
  onToggle: (name: string) => void;
  onClose: () => void;
  emptyHint: string;
}

export function TogglePicker({ title, items, onToggle, onClose, emptyHint }: TogglePickerProps) {
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onClose();
    } else if (key.upArrow) {
      setCursor((prev) => (prev > 0 ? prev - 1 : items.length - 1));
    } else if (key.downArrow) {
      setCursor((prev) => (prev < items.length - 1 ? prev + 1 : 0));
    } else if (key.return || input === ' ') {
      if (items.length > 0) {
        onToggle(items[cursor]!.name);
      }
    }
  });

  if (items.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Box marginBottom={1}>
          <Text bold color={theme.accent}>{title}</Text>
        </Box>
        <Text dimColor>{emptyHint}</Text>
        <Box marginTop={1}>
          <Text dimColor>Esc close</Text>
        </Box>
      </Box>
    );
  }

  const maxNameLen = Math.max(...items.map((i) => i.name.length));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={theme.accent}>{title}</Text>
        <Text dimColor> {'\u2014'} Space/Enter toggle, Esc close</Text>
      </Box>

      {items.map((item, i) => {
        const isFocused = i === cursor;
        const pointer = isFocused ? '\u276F' : ' ';
        const toggle = item.enabled ? '\u25C9' : '\u25CB';
        const toggleColor = item.enabled ? theme.accent : 'gray';
        const padded = item.name.padEnd(maxNameLen + 2);

        return (
          <Box key={item.name} flexDirection="column">
            <Box>
              <Text color={isFocused ? theme.accent : undefined}>{pointer} </Text>
              <Text color={toggleColor}>{toggle} </Text>
              <Text bold color={isFocused ? theme.accent : undefined}>{padded}</Text>
              <Text dimColor={!isFocused}>{item.description}</Text>
              <Text dimColor> ({item.source})</Text>
            </Box>
            {isFocused && item.skills && item.skills.length > 0 && (
              <Box marginLeft={6}>
                <Text dimColor>Skills: {item.skills.join(', ')}</Text>
              </Box>
            )}
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text dimColor>
          {'\u2191\u2193'} navigate {'  '} Space/Enter toggle {'  '} Esc close
        </Text>
      </Box>
    </Box>
  );
}
