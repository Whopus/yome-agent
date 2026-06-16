import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Key } from 'ink';
import { theme } from './theme.js';

export interface VisualLine {
  text: string;
  startOffset: number;
  endOffset: number;
}

interface InputLayout {
  columns: number;
  lines: VisualLine[];
}

interface CursorPosition {
  lineIndex: number;
  column: number;
}

interface MultilineTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  columns: number;
  focus?: boolean;
  prompt?: string;
  promptColor?: string;
  maxVisibleLines?: number;
  onNavigateSuggestion?: (direction: 'up' | 'down') => boolean;
  onAcceptSuggestion?: (submit: boolean) => string | null;
}

const DEFAULT_MAX_VISIBLE_LINES = 8;

let graphemeSegmenter: Intl.Segmenter | null | undefined;

function getSegmenter(): Intl.Segmenter | null {
  if (graphemeSegmenter !== undefined) return graphemeSegmenter;
  const Segmenter = (Intl as typeof Intl & { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  graphemeSegmenter = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;
  return graphemeSegmenter;
}

function graphemes(text: string): Array<{ segment: string; index: number; end: number; width: number }> {
  const segmenter = getSegmenter();
  if (segmenter) {
    return Array.from(segmenter.segment(text), (item) => ({
      segment: item.segment,
      index: item.index,
      end: item.index + item.segment.length,
      width: stringWidth(item.segment),
    }));
  }

  const result: Array<{ segment: string; index: number; end: number; width: number }> = [];
  let index = 0;
  for (const segment of Array.from(text)) {
    result.push({ segment, index, end: index + segment.length, width: stringWidth(segment) });
    index += segment.length;
  }
  return result;
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0xfeff
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
}

function isEmojiCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf)
  );
}

export function stringWidth(text: string): number {
  const segmenter = getSegmenter();
  if (segmenter) {
    let width = 0;
    for (const item of segmenter.segment(text)) {
      width += graphemeWidth(item.segment);
    }
    return width;
  }

  let width = 0;
  for (const segment of Array.from(text)) {
    width += graphemeWidth(segment);
  }
  return width;
}

function graphemeWidth(segment: string): number {
  let width = 0;
  for (const char of Array.from(segment)) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || isZeroWidthCodePoint(codePoint)) continue;
    if (isEmojiCodePoint(codePoint)) return 2;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

export function buildInputLayout(value: string, columns: number): InputLayout {
  const safeColumns = Math.max(1, Math.floor(columns));
  const lines: VisualLine[] = [];
  const logicalLines = value.split('\n');
  let offset = 0;

  for (let i = 0; i < logicalLines.length; i++) {
    const logicalLine = logicalLines[i] ?? '';
    lines.push(...wrapLogicalLine(logicalLine, offset, safeColumns));
    offset += logicalLine.length;
    if (i < logicalLines.length - 1) offset += 1;
  }

  if (lines.length === 0) lines.push({ text: '', startOffset: 0, endOffset: 0 });
  return { columns: safeColumns, lines };
}

function wrapLogicalLine(text: string, startOffset: number, columns: number): VisualLine[] {
  if (text.length === 0) return [{ text: '', startOffset, endOffset: startOffset }];

  const lines: VisualLine[] = [];
  let lineText = '';
  let lineWidth = 0;
  let lineStart = startOffset;

  for (const item of graphemes(text)) {
    const absoluteStart = startOffset + item.index;
    const absoluteEnd = startOffset + item.end;

    if (lineText.length > 0 && lineWidth + item.width > columns) {
      lines.push({ text: lineText, startOffset: lineStart, endOffset: absoluteStart });
      lineText = '';
      lineWidth = 0;
      lineStart = absoluteStart;
    }

    lineText += item.segment;
    lineWidth += item.width;

    if (lineWidth === columns && absoluteEnd < startOffset + text.length) {
      lines.push({ text: lineText, startOffset: lineStart, endOffset: absoluteEnd });
      lineText = '';
      lineWidth = 0;
      lineStart = absoluteEnd;
    }
  }

  if (lineText.length > 0) {
    lines.push({ text: lineText, startOffset: lineStart, endOffset: startOffset + text.length });
  }

  return lines;
}

export function getCursorPosition(layout: InputLayout, cursorOffset: number): CursorPosition {
  const lineIndex = getLineIndexForOffset(layout, cursorOffset);
  const line = layout.lines[lineIndex]!;
  const localEnd = Math.max(0, Math.min(cursorOffset, line.endOffset) - line.startOffset);
  return {
    lineIndex,
    column: stringWidth(line.text.slice(0, localEnd)),
  };
}

function getLineIndexForOffset(layout: InputLayout, cursorOffset: number): number {
  let lineIndex = 0;
  for (let i = 0; i < layout.lines.length; i++) {
    if (layout.lines[i]!.startOffset <= cursorOffset) lineIndex = i;
    else break;
  }
  return Math.max(0, Math.min(lineIndex, layout.lines.length - 1));
}

function getOffsetForColumn(line: VisualLine, column: number): number {
  if (column <= 0) return line.startOffset;

  let width = 0;
  for (const item of graphemes(line.text)) {
    const nextWidth = width + item.width;
    if (nextWidth > column) return line.startOffset + item.index;
    width = nextWidth;
  }

  return line.endOffset;
}

export function moveCursorVertically(
  value: string,
  cursorOffset: number,
  columns: number,
  direction: 'up' | 'down',
  preferredColumn?: number | null,
): number {
  const layout = buildInputLayout(value, columns);
  const position = getCursorPosition(layout, cursorOffset);
  const nextLineIndex = direction === 'up' ? position.lineIndex - 1 : position.lineIndex + 1;
  if (nextLineIndex < 0 || nextLineIndex >= layout.lines.length) return cursorOffset;

  return getOffsetForColumn(
    layout.lines[nextLineIndex]!,
    preferredColumn ?? position.column,
  );
}

function previousGraphemeOffset(value: string, cursorOffset: number): number {
  for (const item of graphemes(value)) {
    if (item.end >= cursorOffset) return item.index;
  }
  return 0;
}

function nextGraphemeOffset(value: string, cursorOffset: number): number {
  for (const item of graphemes(value)) {
    if (item.index >= cursorOffset) return item.end;
    if (item.index < cursorOffset && item.end > cursorOffset) return item.end;
  }
  return value.length;
}

function previousWordOffset(value: string, cursorOffset: number): number {
  let offset = cursorOffset;
  while (offset > 0 && /\s/.test(value.slice(previousGraphemeOffset(value, offset), offset))) {
    offset = previousGraphemeOffset(value, offset);
  }
  while (offset > 0 && !/\s/.test(value.slice(previousGraphemeOffset(value, offset), offset))) {
    offset = previousGraphemeOffset(value, offset);
  }
  return offset;
}

function nextWordOffset(value: string, cursorOffset: number): number {
  let offset = cursorOffset;
  while (offset < value.length && !/\s/.test(value.slice(offset, nextGraphemeOffset(value, offset)))) {
    offset = nextGraphemeOffset(value, offset);
  }
  while (offset < value.length && /\s/.test(value.slice(offset, nextGraphemeOffset(value, offset)))) {
    offset = nextGraphemeOffset(value, offset);
  }
  return offset;
}

function normalizeTypedInput(input: string): string {
  return input
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function clampOffset(value: string, offset: number): number {
  return Math.max(0, Math.min(offset, value.length));
}

function splitLineAtCursor(line: VisualLine, cursorOffset: number): {
  before: string;
  cursor: string;
  after: string;
} {
  const localOffset = clampOffset(line.text, cursorOffset - line.startOffset);
  if (localOffset >= line.text.length) {
    return { before: line.text, cursor: ' ', after: '' };
  }

  for (const item of graphemes(line.text)) {
    if (item.index === localOffset) {
      return {
        before: line.text.slice(0, item.index),
        cursor: item.segment,
        after: line.text.slice(item.end),
      };
    }
    if (item.index > localOffset) {
      return {
        before: line.text.slice(0, item.index),
        cursor: item.segment,
        after: line.text.slice(item.end),
      };
    }
  }

  return { before: line.text, cursor: ' ', after: '' };
}

function getVisibleWindow(lineCount: number, cursorLineIndex: number, maxVisibleLines: number): {
  start: number;
  end: number;
} {
  if (lineCount <= maxVisibleLines) return { start: 0, end: lineCount };
  const half = Math.floor(maxVisibleLines / 2);
  let start = cursorLineIndex - half;
  if (start < 0) start = 0;
  if (start + maxVisibleLines > lineCount) start = lineCount - maxVisibleLines;
  return { start, end: start + maxVisibleLines };
}

export function MultilineTextInput({
  value,
  onChange,
  onSubmit,
  columns,
  focus = true,
  prompt = '> ',
  promptColor = theme.accent,
  maxVisibleLines = DEFAULT_MAX_VISIBLE_LINES,
  onNavigateSuggestion,
  onAcceptSuggestion,
}: MultilineTextInputProps) {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const preferredColumn = useRef<number | null>(null);

  const layout = useMemo(() => buildInputLayout(value, columns), [columns, value]);
  const cursorPosition = useMemo(
    () => getCursorPosition(layout, cursorOffset),
    [cursorOffset, layout],
  );

  useEffect(() => {
    setCursorOffset((offset) => clampOffset(value, offset));
  }, [value]);

  const commitValue = (nextValue: string, nextOffset: number) => {
    preferredColumn.current = null;
    setCursorOffset(clampOffset(nextValue, nextOffset));
    onChange(nextValue);
  };

  const setOffset = (nextOffset: number, keepPreferredColumn = false) => {
    if (!keepPreferredColumn) preferredColumn.current = null;
    setCursorOffset(clampOffset(value, nextOffset));
  };

  const insertText = (text: string) => {
    if (!text) return;
    const nextValue = value.slice(0, cursorOffset) + text + value.slice(cursorOffset);
    commitValue(nextValue, cursorOffset + text.length);
  };

  const replaceBeforeCursor = (deleteCount: number, text: string) => {
    const start = Math.max(0, cursorOffset - deleteCount);
    const nextValue = value.slice(0, start) + text + value.slice(cursorOffset);
    commitValue(nextValue, start + text.length);
  };

  const handleVerticalMove = (direction: 'up' | 'down') => {
    const handledBySuggestions = onNavigateSuggestion?.(direction) ?? false;
    if (handledBySuggestions) return;

    const desiredColumn = preferredColumn.current ?? cursorPosition.column;
    const nextOffset = moveCursorVertically(value, cursorOffset, columns, direction, desiredColumn);
    preferredColumn.current = desiredColumn;
    setOffset(nextOffset, true);
  };

  useInput((input, key: Key) => {
    if (key.ctrl && (input === 'c' || input === 'v')) return;
    if (key.shift && key.tab) return;

    if (key.upArrow) {
      handleVerticalMove('up');
      return;
    }

    if (key.downArrow) {
      handleVerticalMove('down');
      return;
    }

    if (key.tab) {
      const accepted = onAcceptSuggestion?.(false);
      if (accepted !== null && accepted !== undefined) setOffset(accepted.length);
      return;
    }

    if (key.return) {
      const accepted = onAcceptSuggestion?.(true);
      if (accepted !== null && accepted !== undefined) {
        setOffset(accepted.length);
        return;
      }

      if (key.shift || key.meta) {
        insertText('\n');
        return;
      }

      if (cursorOffset > 0 && value[cursorOffset - 1] === '\\') {
        replaceBeforeCursor(1, '\n');
        return;
      }

      onSubmit(value);
      return;
    }

    if (key.leftArrow) {
      setOffset(key.ctrl || key.meta ? previousWordOffset(value, cursorOffset) : previousGraphemeOffset(value, cursorOffset));
      return;
    }

    if (key.rightArrow) {
      setOffset(key.ctrl || key.meta ? nextWordOffset(value, cursorOffset) : nextGraphemeOffset(value, cursorOffset));
      return;
    }

    if (key.backspace) {
      if (cursorOffset === 0) return;
      const previousOffset = previousGraphemeOffset(value, cursorOffset);
      const nextValue = value.slice(0, previousOffset) + value.slice(cursorOffset);
      commitValue(nextValue, previousOffset);
      return;
    }

    if (key.delete || (key.ctrl && input === 'd')) {
      if (cursorOffset >= value.length) return;
      const nextOffset = nextGraphemeOffset(value, cursorOffset);
      const nextValue = value.slice(0, cursorOffset) + value.slice(nextOffset);
      commitValue(nextValue, cursorOffset);
      return;
    }

    if (key.ctrl && input === 'a') {
      setOffset(layout.lines[cursorPosition.lineIndex]!.startOffset);
      return;
    }

    if (key.ctrl && input === 'e') {
      setOffset(layout.lines[cursorPosition.lineIndex]!.endOffset);
      return;
    }

    if (key.ctrl && input === 'u') {
      const lineStart = layout.lines[cursorPosition.lineIndex]!.startOffset;
      const nextValue = value.slice(0, lineStart) + value.slice(cursorOffset);
      commitValue(nextValue, lineStart);
      return;
    }

    if (key.ctrl && input === 'k') {
      const lineEnd = layout.lines[cursorPosition.lineIndex]!.endOffset;
      const nextValue = value.slice(0, cursorOffset) + value.slice(lineEnd);
      commitValue(nextValue, cursorOffset);
      return;
    }

    if (input === '\x1b[H' || input === '\x1b[1~') {
      setOffset(layout.lines[cursorPosition.lineIndex]!.startOffset);
      return;
    }

    if (input === '\x1b[F' || input === '\x1b[4~') {
      setOffset(layout.lines[cursorPosition.lineIndex]!.endOffset);
      return;
    }

    if (key.escape || key.pageDown || key.pageUp) return;

    insertText(normalizeTypedInput(input));
  }, { isActive: focus });

  const visibleWindow = getVisibleWindow(
    layout.lines.length,
    cursorPosition.lineIndex,
    Math.max(1, maxVisibleLines),
  );
  const visibleLines = layout.lines.slice(visibleWindow.start, visibleWindow.end);
  const promptPadding = ' '.repeat(prompt.length);

  return (
    <Box flexDirection="column" width="100%">
      {visibleWindow.start > 0 && (
        <Box>
          <Text>{promptPadding}</Text>
          <Text dimColor>...</Text>
        </Box>
      )}
      {visibleLines.map((line, index) => {
        const realIndex = visibleWindow.start + index;
        const hasCursor = realIndex === cursorPosition.lineIndex;
        const prefix = realIndex === 0 ? prompt : promptPadding;
        const split = hasCursor ? splitLineAtCursor(line, cursorOffset) : null;

        return (
          <Box key={`${line.startOffset}-${line.endOffset}-${realIndex}`}>
            <Text color={promptColor}>{prefix}</Text>
            {split ? (
              <>
                <Text wrap="truncate-end">{split.before}</Text>
                <Text inverse>{split.cursor}</Text>
                <Text wrap="truncate-end">{split.after}</Text>
              </>
            ) : (
              <Text wrap="truncate-end">{line.text.length > 0 ? line.text : ' '}</Text>
            )}
          </Box>
        );
      })}
      {visibleWindow.end < layout.lines.length && (
        <Box>
          <Text>{promptPadding}</Text>
          <Text dimColor>...</Text>
        </Box>
      )}
    </Box>
  );
}
