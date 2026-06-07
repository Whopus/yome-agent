import { opendir, stat } from 'fs/promises';
import { resolve, join } from 'path';
import type { ToolDef } from '../types.js';

const MAX_ENTRIES = 500;

export const lsTool: ToolDef = {
  name: 'LS',
  description: 'List contents of a directory.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list (default: cwd)' },
    },
  },
  isReadOnly() { return true; },
  getPath(input) { return input.path as string | undefined; },
  async execute(input) {
    const dirPath = resolve((input.path as string) || process.cwd());

    try {
      const dir = await opendir(dirPath);
      const lines: string[] = [];
      let truncated = false;

      try {
        let entry = await dir.read();
        while (entry) {
          if (!entry.name.startsWith('.') || entry.name === '.gitignore') {
            const fullPath = join(dirPath, entry.name);
            try {
              const s = await stat(fullPath);
              const size = entry.isDirectory() ? '' : formatSize(s.size);
              const type = entry.isDirectory() ? 'd' : '-';
              lines.push(`${type}  ${size.padStart(8)}  ${entry.name}${entry.isDirectory() ? '/' : ''}`);
            } catch {
              lines.push(`?           ${entry.name}`);
            }
            if (lines.length >= MAX_ENTRIES) {
              truncated = true;
              break;
            }
          }
          entry = await dir.read();
        }
      } finally {
        await dir.close().catch(() => {});
      }

      if (lines.length === 0) return '(empty directory)';
      let result = lines.join('\n');
      if (truncated) result += `\n\n[Showing first ${MAX_ENTRIES} entries]`;
      return result;
    } catch {
      return `Error: Cannot read directory: ${dirPath}`;
    }
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}
