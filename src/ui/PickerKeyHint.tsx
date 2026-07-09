// Single source of truth for the key-hint line at the bottom (or top)
// of every picker panel. Each picker used to roll its own dim-text row
// with slightly different punctuation, spacing and word choice
// ("navigate" vs "nav", em dash vs hyphen, Esc "cancel" vs "close" vs
// "close the picker"), which made the whole TUI feel inconsistent.
//
// Usage:
//
//   <PickerKeyHint
//     hints={[
//       { keys: '↑↓', label: 'nav' },
//       { keys: 'Enter', label: 'select' },
//       { keys: 'Esc', label: 'close' },
//     ]}
//   />
//
// The component takes care of spacing, dimColor, and colored keycap
// rendering. Keep labels lowercase and terse to match surrounding chat
// copy.

import React from 'react';
import { Box, Text } from 'ink';

export interface PickerHint {
  keys: string;
  label: string;
}

interface PickerKeyHintProps {
  hints: PickerHint[];
  /** Color for the keycap text. Defaults to the brand accent. */
  color?: string;
  /** Extra spacing above the row. Matches the old `marginTop={1}` idiom. */
  marginTop?: number;
}

const DEFAULT_COLOR = '#E87B35';

export const PickerKeyHint = React.memo(function PickerKeyHint({
  hints,
  color = DEFAULT_COLOR,
  marginTop = 1,
}: PickerKeyHintProps) {
  return (
    <Box marginTop={marginTop}>
      <Text dimColor wrap="truncate-end">
        {hints.map((h, i) => (
          <React.Fragment key={i}>
            {i > 0 && <Text dimColor>{'   '}</Text>}
            <Text color={color}>{h.keys}</Text>
            <Text> </Text>
            <Text>{h.label}</Text>
          </React.Fragment>
        ))}
      </Text>
    </Box>
  );
});
