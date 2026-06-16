import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { PermissionMode } from '../permissions/types.js';
import { MultilineTextInput } from './MultilineTextInput.js';
import { theme } from './theme.js';

export interface SlashCommand {
  name: string;
  description: string;
}

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  model?: string;
  loopName: string;
  slashCommands?: SlashCommand[];
  permissionMode?: PermissionMode;
  imageCount?: number;
}

const MAX_VISIBLE = 5;

function getPermissionLabel(mode: PermissionMode): { text: string; color: string } {
  switch (mode) {
    case 'bypassPermissions':
      return { text: 'Bypass - all commands allowed', color: theme.danger };
    case 'acceptEdits':
      return { text: 'Auto - edit and read-only commands', color: theme.warning };
    case 'default':
    default:
      return { text: 'Default - ask before write operations', color: theme.accent };
  }
}

export function InputBar({ value, onChange, onSubmit, model, loopName, slashCommands = [], permissionMode = 'default', imageCount = 0 }: InputBarProps) {
  const [cursor, setCursor] = useState(0);
  const { stdout } = useStdout();

  const filtered = useMemo(() => {
    if (!value.startsWith('/')) return [];
    const query = value.slice(1).toLowerCase();
    return slashCommands.filter((c) => c.name.toLowerCase().startsWith(query));
  }, [value, slashCommands]);

  const showSuggestions = filtered.length > 0 && value.startsWith('/') && !/\s/.test(value.slice(1));

  useEffect(() => {
    setCursor(0);
  }, [filtered.length]);

  const handleAcceptSuggestion = useCallback((submit: boolean): string | null => {
    if (showSuggestions && filtered[cursor]) {
      const selected = '/' + filtered[cursor]!.name;
      onChange(selected);
      if (submit) onSubmit(selected);
      return selected;
    }
    return null;
  }, [showSuggestions, filtered, cursor, onChange, onSubmit]);

  const handleNavigateSuggestion = useCallback((direction: 'up' | 'down'): boolean => {
    if (!showSuggestions) return false;
    if (direction === 'up') {
      setCursor((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
    } else {
      setCursor((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
    }
    return true;
  }, [showSuggestions, filtered.length]);

  const maxNameLen = showSuggestions
    ? Math.max(...filtered.map((c) => c.name.length))
    : 0;

  // Compute visible window for scrollable slash menu
  const visibleStart = useMemo(() => {
    if (filtered.length <= MAX_VISIBLE) return 0;
    const half = Math.floor(MAX_VISIBLE / 2);
    let start = cursor - half;
    if (start < 0) start = 0;
    if (start + MAX_VISIBLE > filtered.length) start = filtered.length - MAX_VISIBLE;
    return start;
  }, [cursor, filtered.length]);

  const visibleItems = showSuggestions ? filtered.slice(visibleStart, visibleStart + MAX_VISIBLE) : [];
  const hasScrollUp = visibleStart > 0;
  const hasScrollDown = visibleStart + MAX_VISIBLE < filtered.length;

  const perm = getPermissionLabel(permissionMode);
  const terminalColumns = stdout.columns ?? process.stdout.columns ?? 80;
  const inputColumns = Math.max(10, terminalColumns - 8);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingX={1} justifyContent="space-between">
        <Text color={perm.color}>{perm.text}</Text>
        <Text dimColor>{model || 'qwen-plus'}</Text>
      </Box>
      {imageCount > 0 && (
        <Box paddingX={1}>
          <Text color={theme.accent} bold>{`\u{1F4CE} ${imageCount} image${imageCount > 1 ? 's' : ''} attached`}</Text>
          <Text dimColor> (press Enter to send)</Text>
        </Box>
      )}
      <Box borderStyle="round" borderColor="gray" paddingX={1} width="100%">
        <MultilineTextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          columns={inputColumns}
          prompt="> "
          promptColor={theme.accent}
          onNavigateSuggestion={handleNavigateSuggestion}
          onAcceptSuggestion={handleAcceptSuggestion}
        />
      </Box>
      {showSuggestions && (
        <Box flexDirection="column" paddingX={1} marginTop={0}>
          {hasScrollUp && (
            <Box>
              <Text dimColor>  {'↑'} more</Text>
            </Box>
          )}
          {visibleItems.map((item, vi) => {
            const realIdx = visibleStart + vi;
            const isFocused = realIdx === cursor;
            const padded = ('/' + item.name).padEnd(maxNameLen + 3);
            return (
              <Box key={item.name}>
                <Text color={isFocused ? theme.accent : undefined} dimColor={!isFocused} bold={isFocused}>{padded}</Text>
                <Text dimColor={!isFocused}>{item.description}</Text>
              </Box>
            );
          })}
          {hasScrollDown && (
            <Box>
              <Text dimColor>  {'↓'} more</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
