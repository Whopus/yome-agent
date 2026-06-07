import React from 'react';
import { Box, Text } from 'ink';

interface ToolResultProps {
  name: string;
  result: string;
}

const UI_SUMMARY_PREFIX = '@@YOME_UI_SUMMARY:';

function DiffView({ result }: { result: string }) {
  const allLines = result.split('\n');
  const diffLines = allLines.slice(2);

  const maxShow = 30;
  const truncated = diffLines.length > maxShow;
  const shown = truncated ? diffLines.slice(0, maxShow) : diffLines;

  let maxNum = 0;
  for (const line of shown) {
    const m = line.match(/^@@[^:]*:(\d+):/);
    if (m) maxNum = Math.max(maxNum, Number(m[1]));
  }
  const numWidth = Math.max(String(maxNum).length, 3);

  const cols = (process.stdout.columns || 80) - 4;

  return (
    <Box flexDirection="column" marginLeft={4}>
      <Text dimColor>{'─'.repeat(cols)}</Text>
      {shown.map((line, i) => {
        const ctxMatch = line.match(/^@@CTX:(\d+):(.*)/);
        const addMatch = line.match(/^@@\+:(\d+):(.*)/);
        const rmMatch = line.match(/^@@-:(\d+):(.*)/);

        if (addMatch) {
          const num = addMatch[1]!.padStart(numWidth);
          return (
            <Box key={i}>
              <Text color="green">{`  ${num} + ${addMatch[2] ?? ''}`}</Text>
            </Box>
          );
        }
        if (rmMatch) {
          const num = rmMatch[1]!.padStart(numWidth);
          return (
            <Box key={i}>
              <Text color="red">{`  ${num} - ${rmMatch[2] ?? ''}`}</Text>
            </Box>
          );
        }
        if (ctxMatch) {
          const num = ctxMatch[1]!.padStart(numWidth);
          return (
            <Box key={i}>
              <Text dimColor>{`  ${num}   ${ctxMatch[2] ?? ''}`}</Text>
            </Box>
          );
        }
        return <Text key={i} dimColor>{`  ${line}`}</Text>;
      })}
      <Text dimColor>{'─'.repeat(cols)}</Text>
      {truncated && <Text dimColor>{`  … ${diffLines.length - maxShow} more lines`}</Text>}
    </Box>
  );
}

export function ToolResult({ name, result }: ToolResultProps) {
  if (result.startsWith(UI_SUMMARY_PREFIX)) {
    return (
      <Box marginLeft={4}>
        <Text dimColor>{result.slice(UI_SUMMARY_PREFIX.length)}</Text>
      </Box>
    );
  }

  // Permission denial — surface a concise red line so the user can see the
  // tool was blocked. The full guidance text is kept in the tool_result that
  // goes back to the model.
  if (result.startsWith('[YOME_PERMISSION_DENIED]')) {
    return (
      <Box marginLeft={4}>
        <Text color="red">{`✕ ${name} — permission denied`}</Text>
      </Box>
    );
  }

  // Read, LS, Grep, Glob, Bash — don't show content to user (it's for the AI)
  if (name === 'Read' || name === 'LS' || name === 'Grep' || name === 'Glob') {
    return null;
  }

  // Bash — show a brief summary
  if (name === 'Bash') {
    const lines = result.split('\n');
    const lineCount = lines.length;
    if (result.startsWith('Exit code:')) {
      return (
        <Box marginLeft={4}>
          <Text color="red" dimColor>{result.split('\n')[0]}</Text>
        </Box>
      );
    }
    if (lineCount > 3) {
      return (
        <Box marginLeft={4}>
          <Text dimColor>{`(${lineCount} lines of output)`}</Text>
        </Box>
      );
    }
    return null;
  }

  // Edit/Write — show diff
  if (result.startsWith('@@FILE:')) {
    return <DiffView result={result} />;
  }

  return null;
}
