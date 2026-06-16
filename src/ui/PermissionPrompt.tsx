import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { theme } from './theme.js';

export type PermissionChoice =
  | { kind: 'allow_once' }
  | { kind: 'allow_session'; ruleString: string }
  | { kind: 'allow_always'; ruleString: string }
  | { kind: 'deny'; feedback?: string };

interface PermissionPromptProps {
  toolName: string;
  message: string;
  detail?: string;
  /** Suggested rule string for "always allow" / "session allow" persistence. */
  suggestedRule: string;
  onResolve: (choice: PermissionChoice) => void;
}

type OptionId = 'allow' | 'session' | 'always' | 'deny';

const OPTIONS: { id: OptionId; label: (rule: string) => string }[] = [
  { id: 'allow', label: () => '是，允许（仅本次）' },
  { id: 'session', label: (r) => `是，本会话内不再询问 (${r})` },
  { id: 'always', label: (r) => `是，并永久允许 (${r}) — 写入 ~/.yome/settings.json` },
  { id: 'deny', label: () => '否，并可选告知原因 (Esc 直接拒绝)' },
];

export function PermissionPrompt({ toolName, message, detail, suggestedRule, onResolve }: PermissionPromptProps) {
  const [cursor, setCursor] = useState(0);
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [editingRule, setEditingRule] = useState(false);
  const [ruleDraft, setRuleDraft] = useState(suggestedRule);
  const [pendingScope, setPendingScope] = useState<'session' | 'always' | null>(null);

  useInput((_input, key) => {
    if (feedbackMode || editingRule) return; // TextInput handles keys
    if (key.upArrow) {
      setCursor((prev) => (prev > 0 ? prev - 1 : OPTIONS.length - 1));
    } else if (key.downArrow) {
      setCursor((prev) => (prev < OPTIONS.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      const selected = OPTIONS[cursor]!.id;
      if (selected === 'allow') {
        onResolve({ kind: 'allow_once' });
      } else if (selected === 'session') {
        if (suggestedRule.includes('(')) {
          // Pre-formed rule like "Bash(npm run:*)" — let user edit
          setPendingScope('session');
          setEditingRule(true);
        } else {
          onResolve({ kind: 'allow_session', ruleString: suggestedRule });
        }
      } else if (selected === 'always') {
        if (suggestedRule.includes('(')) {
          setPendingScope('always');
          setEditingRule(true);
        } else {
          onResolve({ kind: 'allow_always', ruleString: suggestedRule });
        }
      } else if (selected === 'deny') {
        setFeedbackMode(true);
      }
    } else if (key.escape) {
      onResolve({ kind: 'deny' });
    }
  });

  const handleFeedbackSubmit = (value: string): void => {
    onResolve({ kind: 'deny', feedback: value.trim() || undefined });
  };

  const handleRuleSubmit = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) {
      setEditingRule(false);
      setPendingScope(null);
      return;
    }
    if (pendingScope === 'session') {
      onResolve({ kind: 'allow_session', ruleString: trimmed });
    } else if (pendingScope === 'always') {
      onResolve({ kind: 'allow_always', ruleString: trimmed });
    }
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginTop={1}>
      <Box>
        <Text bold color={theme.accent}>{toolName}</Text>
        <Text>: {message}</Text>
      </Box>
      {detail && (
        <Box marginTop={1}>
          <Text dimColor>{'   '}</Text>
          <Text>{detail.length > 200 ? detail.slice(0, 200) + '…' : detail}</Text>
        </Box>
      )}

      {!feedbackMode && !editingRule && OPTIONS.map((opt, i) => {
        const isFocused = i === cursor;
        const pointer = isFocused ? '> ' : '  ';
        return (
          <Box key={opt.id}>
            <Text color={isFocused ? theme.accent : undefined} bold={isFocused}>{pointer}{opt.label(suggestedRule)}</Text>
          </Box>
        );
      })}

      {editingRule && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>编辑 {pendingScope === 'always' ? '永久' : '本会话'} 允许规则（Enter 确认，空值取消）：</Text>
          <Box>
            <Text color={theme.accent}>{'> '}</Text>
            <TextInput value={ruleDraft} onChange={setRuleDraft} onSubmit={handleRuleSubmit} />
          </Box>
        </Box>
      )}

      {feedbackMode && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>告诉 agent 拒绝原因（Enter 确认，留空表示无反馈）：</Text>
          <Box>
            <Text color={theme.accent}>{'> '}</Text>
            <TextInput value={feedback} onChange={setFeedback} onSubmit={handleFeedbackSubmit} />
          </Box>
        </Box>
      )}

      {!feedbackMode && !editingRule && (
        <Box marginTop={1}>
          <Text dimColor>{'\u2191\u2193'} 导航  Enter 选择  Esc 直接拒绝</Text>
        </Box>
      )}
    </Box>
  );
}
