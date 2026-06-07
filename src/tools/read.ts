import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { resolve } from 'path';
import type { ToolDef } from '../types.js';

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 2000;
const MAX_RESULT_CHARS = 20_000;
const MAX_LINE_CHARS = 4000;

function addLineNumbers(lines: string[], startLine: number): string {
  return lines
    .map((line, i) => `${startLine + i}\t${line}`)
    .join('\n');
}

function readLineWindow(
  filePath: string,
  offset: number,
  limit: number,
): Promise<{ lines: string[]; truncated: boolean; hitCharBudget: boolean }> {
  return new Promise((resolveP, reject) => {
    const stream = createReadStream(filePath, { encoding: 'utf-8', highWaterMark: 64 * 1024 });
    const lines: string[] = [];
    let lineNo = 1;
    let current = '';
    let currentTruncated = false;
    let totalChars = 0;
    let sawData = false;
    let done = false;
    let truncated = false;
    let hitCharBudget = false;

    const finish = () => {
      if (done) return;
      done = true;
      resolveP({ lines, truncated, hitCharBudget });
    };

    const appendChar = (ch: string) => {
      if (lineNo < offset || lines.length >= limit) return;
      const canKeep =
        current.length < MAX_LINE_CHARS &&
        totalChars + current.length < MAX_RESULT_CHARS;
      if (canKeep) {
        current += ch;
      } else {
        currentTruncated = true;
        if (totalChars + current.length >= MAX_RESULT_CHARS) hitCharBudget = true;
      }
    };

    const commitLine = (): boolean => {
      if (lineNo >= offset && lines.length < limit) {
        const suffix = currentTruncated ? ' [line truncated]' : '';
        lines.push(current + suffix);
        totalChars += current.length + suffix.length + 16;
        if (lines.length >= limit || totalChars >= MAX_RESULT_CHARS) {
          truncated = true;
          if (totalChars >= MAX_RESULT_CHARS) hitCharBudget = true;
          stream.destroy();
          finish();
          return true;
        }
      }
      lineNo++;
      current = '';
      currentTruncated = false;
      return false;
    };

    stream.on('data', (chunk: string | Buffer) => {
      if (done) return;
      sawData = true;
      for (const ch of String(chunk)) {
        if (ch === '\n') {
          if (commitLine()) return;
        } else if (ch !== '\r') {
          appendChar(ch);
        }
      }
    });

    stream.on('end', () => {
      if (!done && (sawData || current.length > 0) && lines.length < limit) {
        commitLine();
      }
      finish();
    });

    stream.on('error', (err) => {
      if (!done) reject(err);
    });
  });
}

export const readTool: ToolDef = {
  name: 'Read',
  description: 'Read the contents of a file. Supports offset and limit for large files.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute path to the file to read' },
      offset: { type: 'number', description: 'Line number to start reading from (1-based). Default: 1' },
      limit: { type: 'number', description: 'Maximum number of lines to read. Default: 2000' },
    },
    required: ['file_path'],
  },
  isReadOnly() { return true; },
  validateInput(input) {
    if (typeof input.file_path !== 'string' || !input.file_path.trim()) {
      return { valid: false, error: 'file_path is required' };
    }
    return { valid: true };
  },
  getPath(input) { return input.file_path as string | undefined; },
  async execute(input) {
    const filePath = resolve(input.file_path as string);
    const offset = Math.max(1, (input.offset as number) || 1);
    const requestedLimit = Math.max(1, (input.limit as number) || DEFAULT_LIMIT);
    const limit = Math.min(requestedLimit, MAX_LIMIT);

    try {
      await stat(filePath);
    } catch {
      return `Error: File not found: ${filePath}`;
    }

    const { lines, truncated, hitCharBudget } = await readLineWindow(filePath, offset, limit);
    const numbered = addLineNumbers(lines, offset);
    let result = numbered;

    if (requestedLimit > MAX_LIMIT) {
      result += `\n\n[Requested ${requestedLimit} lines; capped at ${MAX_LIMIT} lines]`;
    }

    if (truncated) {
      result += `\n\n[Showing at most ${limit} lines from ${offset}]`;
    }

    if (hitCharBudget) {
      result += `\n[Read output capped at ${MAX_RESULT_CHARS} chars]`;
    }

    return result || '(empty file or offset beyond EOF)';
  },
};
