import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ModelEntry } from '../config.js';
import { PickerKeyHint } from './PickerKeyHint.js';

interface ModelPickerProps {
  models: ModelEntry[];
  currentModel?: string;
  onSelect: (entry: ModelEntry) => void;
  onCancel: () => void;
}

const MAX_VISIBLE = 8;

export function ModelPicker({ models, currentModel, onSelect, onCancel }: ModelPickerProps) {
  const [cursor, setCursor] = useState(() => {
    const idx = models.findIndex((m) => m.model === currentModel || m.id === currentModel);
    return idx >= 0 ? idx : 0;
  });

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((prev) => (prev > 0 ? prev - 1 : models.length - 1));
    } else if (key.downArrow) {
      setCursor((prev) => (prev < models.length - 1 ? prev + 1 : 0));
    } else if (key.return) {
      if (models.length > 0) onSelect(models[cursor]!);
    } else if (key.escape || (key.ctrl && input === 'c')) {
      onCancel();
    }
  });

  if (models.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Box marginBottom={1}>
          <Text bold color="#E87B35">Model</Text>
        </Box>
        <Text dimColor>
          {'No models configured.\n\nAdd models to ~/.yome/settings.json:\n'}
          {'  {\n    "customModels": [\n      {\n        "displayName": "My Model",\n'}
          {'        "model": "model-name",\n        "baseUrl": "https://...",\n'}
          {'        "apiKey": "sk-...",\n        "provider": "anthropic"\n      }\n    ]\n  }'}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>Esc close</Text>
        </Box>
      </Box>
    );
  }

  const maxNameLen = Math.max(...models.map((m) => m.displayName.length));

  // Scrollable window
  const visibleStart = useMemo(() => {
    if (models.length <= MAX_VISIBLE) return 0;
    const half = Math.floor(MAX_VISIBLE / 2);
    let start = cursor - half;
    if (start < 0) start = 0;
    if (start + MAX_VISIBLE > models.length) start = models.length - MAX_VISIBLE;
    return start;
  }, [cursor, models.length]);

  const visibleItems = models.slice(visibleStart, visibleStart + MAX_VISIBLE);
  const hasScrollUp = visibleStart > 0;
  const hasScrollDown = visibleStart + MAX_VISIBLE < models.length;

  // Mask API key for display
  function maskKey(key: string): string {
    if (key.length <= 8) return '****';
    return key.slice(0, 4) + '...' + key.slice(-4);
  }

  // Shorten base URL for display
  function shortUrl(url: string): string {
    try {
      const u = new URL(url);
      return u.hostname;
    } catch {
      return url.slice(0, 30);
    }
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} paddingY={0}>
      <Box marginBottom={1}>
        <Text bold color="#E87B35">Model</Text>
        <Text dimColor> {'\u2014'} {'\u2191\u2193'} navigate, Enter select, Esc cancel</Text>
      </Box>

      {hasScrollUp && (
        <Box>
          <Text dimColor>  {'\u2191'} more</Text>
        </Box>
      )}

      {visibleItems.map((entry, vi) => {
        const realIdx = visibleStart + vi;
        const isFocused = realIdx === cursor;
        const isActive = entry.model === currentModel || entry.id === currentModel;
        const pointer = isFocused ? '\u276F' : ' ';
        const padded = entry.displayName.padEnd(maxNameLen + 2);
        const nameColor = isActive ? '#E87B35' : isFocused ? '#E87B35' : undefined;

        return (
          <Box key={`${entry.id}-${realIdx}`} flexDirection="column">
            <Box>
              <Text color={isFocused ? '#E87B35' : undefined}>{pointer} </Text>
              <Text bold color={nameColor}>{padded}</Text>
              {isActive && <Text color="#E87B35" dimColor>{' (active)  '}</Text>}
              {!isActive && <Text>{'           '}</Text>}
              <Text dimColor>{shortUrl(entry.baseUrl)}</Text>
            </Box>
            {isFocused && (
              <Box marginLeft={4}>
                <Text dimColor>model: {entry.model}  provider: {entry.provider}  key: {maskKey(entry.apiKey)}</Text>
              </Box>
            )}
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
          { keys: 'Enter', label: 'select' },
          { keys: 'Esc', label: 'close' },
        ]}
      />
    </Box>
  );
}
