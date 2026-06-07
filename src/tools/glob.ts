import fg from 'fast-glob';
import { resolve } from 'path';
import type { ToolDef } from '../types.js';

const MAX_RESULTS = 100;

export const globTool: ToolDef = {
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns file paths.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match (e.g. "**/*.ts")' },
      path: { type: 'string', description: 'Directory to search in (default: cwd)' },
    },
    required: ['pattern'],
  },
  isReadOnly() { return true; },
  validateInput(input) {
    if (typeof input.pattern !== 'string' || !input.pattern.trim()) {
      return { valid: false, error: 'pattern is required' };
    }
    return { valid: true };
  },
  getPath(input) { return input.path as string | undefined; },
  async execute(input) {
    const pattern = input.pattern as string;
    const searchPath = resolve((input.path as string) || process.cwd());

    const stream = fg.stream(pattern, {
      cwd: searchPath,
      ignore: ['**/node_modules/**', '**/.git/**'],
      dot: true,
      onlyFiles: true,
      absolute: false,
    });

    const shown: string[] = [];
    let truncated = false;

    for await (const entry of stream as AsyncIterable<string | Buffer>) {
      if (shown.length >= MAX_RESULTS) {
        truncated = true;
        (stream as any).destroy?.();
        break;
      }
      shown.push(String(entry));
    }

    if (shown.length === 0) return 'No files found';

    shown.sort();
    let result = truncated
      ? `Found at least ${MAX_RESULTS + 1} file(s)\n${shown.join('\n')}`
      : `Found ${shown.length} file(s)\n${shown.join('\n')}`;
    if (truncated) result += '\n(Results truncated. Use a more specific pattern.)';
    return result;
  },
};
