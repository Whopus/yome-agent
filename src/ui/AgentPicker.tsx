import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PickerKeyHint } from './PickerKeyHint.js';

export interface AgentOption {
  name: string;
  description: string;
  active: boolean;
}

interface AgentPickerProps {
  options: AgentOption[];
  onSelect: (name: string) => void;
  onCancel: () => void;
}

export function AgentPicker({ options, onSelect, onCancel }: AgentPickerProps) {
  const [cursor, setCursor] = useState(() => {
    const idx = options.findIndex((o) => o.active);
    return idx >= 0 ? idx : 0;
  });

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((prev) => (prev > 0 ? prev - 1 : options.length - 1));
    } else if (key.downArrow) {
      setCursor((prev) => (prev < options.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      onSelect(options[cursor].name);
    } else if (key.escape || (key.ctrl && input === 'c')) {
      onCancel();
    }
  });

  const maxNameLen = Math.max(...options.map((o) => o.name.length));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} paddingY={0}>
      <Box marginBottom={1}>
        <Text bold color="#E87B35">Agent Loop</Text>
        <Text dimColor> {'\u2014'} select with {'\u2191\u2193'}, confirm with Enter, Esc to cancel</Text>
      </Box>

      {options.map((opt, i) => {
        const isFocused = i === cursor;
        const pointer = isFocused ? '\u276F' : ' ';
        const nameColor = opt.active ? '#E87B35' : isFocused ? '#E87B35' : undefined;
        const padded = opt.name.padEnd(maxNameLen + 2);

        return (
          <Box key={opt.name}>
            <Text color={isFocused ? '#E87B35' : undefined}>{pointer} </Text>
            <Text bold color={nameColor}>{padded}</Text>
            {opt.active && <Text color="#E87B35" dimColor>{' (active)  '}</Text>}
            {!opt.active && <Text>{'           '}</Text>}
            <Text dimColor={!isFocused}>
              {opt.description}
            </Text>
          </Box>
        );
      })}

      <PickerKeyHint
        hints={[
          { keys: '\u2191\u2193', label: 'nav' },
          { keys: 'Enter', label: 'select' },
          { keys: 'Esc', label: 'close' },
        ]}
      />
    </Box>
  );
}
