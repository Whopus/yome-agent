// cli/src/ui/AskUserPrompt.tsx
//
// Renders one question at a time from the AskUser tool. The user
// navigates options with ↑/↓, picks "Custom answer" to type a free-text
// response, presses Enter to confirm, and Esc to cancel the entire
// batch. After the last question is answered, onResolve is called with
// a map of question text → chosen label / custom text.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { AskUserQuestion, AskUserResult } from '../tools/askUser.js';
import { theme } from './theme.js';

interface AskUserPromptProps {
  questions: AskUserQuestion[];
  onResolve: (result: AskUserResult) => void;
}

const CUSTOM_LABEL = '✎ 自定义答案';

export function AskUserPrompt({ questions, onResolve }: AskUserPromptProps) {
  const [qIndex, setQIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const current = questions[qIndex]!;
  // Synthetic last entry: "Custom answer" — always available, never
  // counted toward the agent's max-options validation (which only
  // limits the agent-supplied options, not the UI's own escape hatch).
  const fullOptions = [
    ...current.options.map((o) => ({ label: o.label, description: o.description })),
    { label: CUSTOM_LABEL, description: undefined as string | undefined },
  ];

  const commit = (answer: string): void => {
    const nextAnswers = { ...answers, [current.question]: answer };
    setAnswers(nextAnswers);
    if (qIndex + 1 >= questions.length) {
      onResolve({ answers: nextAnswers });
      return;
    }
    setQIndex(qIndex + 1);
    setCursor(0);
    setCustomMode(false);
    setCustomText('');
  };

  useInput((_input, key) => {
    if (customMode) return; // TextInput handles its own keys
    if (key.upArrow) {
      setCursor((prev) => (prev > 0 ? prev - 1 : fullOptions.length - 1));
    } else if (key.downArrow) {
      setCursor((prev) => (prev < fullOptions.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      const chosen = fullOptions[cursor]!;
      if (chosen.label === CUSTOM_LABEL) {
        setCustomMode(true);
      } else {
        commit(chosen.label);
      }
    } else if (key.escape) {
      onResolve({ answers, cancelled: true });
    }
  });

  const handleCustomSubmit = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) {
      // Empty input → bail back to the option list, don't submit blank.
      setCustomMode(false);
      setCustomText('');
      return;
    }
    commit(trimmed);
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginTop={1}>
      <Box>
        <Text bold color={theme.accent}>[{current.header}]</Text>
        <Text dimColor>
          {' '}问题 {qIndex + 1}/{questions.length}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>{current.question}</Text>
      </Box>

      {!customMode && (
        <Box flexDirection="column" marginTop={1}>
          {fullOptions.map((opt, i) => {
            const isFocused = i === cursor;
            const pointer = isFocused ? '> ' : '  ';
            const isCustom = opt.label === CUSTOM_LABEL;
            return (
              <Box key={`${i}-${opt.label}`}>
                <Text color={isFocused ? theme.accent : undefined} bold={isFocused} dimColor={isCustom && !isFocused}>
                  {pointer}{opt.label}
                </Text>
                {opt.description && (
                  <Text dimColor>{'  — ' + opt.description}</Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {customMode && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>输入自定义答案（Enter 确认，留空返回选项列表）：</Text>
          <Box>
            <Text color={theme.accent}>{'> '}</Text>
            <TextInput value={customText} onChange={setCustomText} onSubmit={handleCustomSubmit} />
          </Box>
        </Box>
      )}

      {!customMode && (
        <Box marginTop={1}>
          <Text dimColor>{'\u2191\u2193'} 导航  Enter 选择  Esc 取消整批问题</Text>
        </Box>
      )}
    </Box>
  );
}
