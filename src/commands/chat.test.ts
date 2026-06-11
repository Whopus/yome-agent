import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runChatSubcommand } from './chat.js';

const RAW_QWEN_RESPONSE = {
  output: {
    choices: [
      {
        message: {
          content: [
            {
              processed_text: JSON.stringify({
                items: [
                  { text: 'Poster Title', rotate_rect: [20, 10, 18, 6, 0] },
                  { text: '42%', rotate_rect: [40, 28, 12, 6, 0] },
                ],
              }),
            },
          ],
        },
      },
    ],
  },
};

function fakePng(width = 80, height = 40): Buffer {
  const buf = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe('chat model ocr', () => {
  let stdout = '';
  let stderr = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('re-parses a raw Qwen response for a local image and writes poster-layer artifacts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yome-chat-ocr-local-'));
    const imagePath = join(dir, 'poster.png');
    const rawPath = join(dir, 'raw.json');
    const outDir = join(dir, 'out');
    writeFileSync(imagePath, fakePng());
    writeFileSync(rawPath, JSON.stringify(RAW_QWEN_RESPONSE), 'utf-8');

    const exit = await runChatSubcommand(['model', 'ocr', imagePath], {
      rawResponse: rawPath,
      out: outDir,
      json: true,
      local: true,
    });

    expect(exit).toBe(0);
    expect(stderr).toBe('');
    const parsed = JSON.parse(stdout) as { ok: boolean; items: Array<{ text: string }>; artifacts: Record<string, string> };
    expect(parsed.ok).toBe(true);
    expect(parsed.items.map((item) => item.text)).toEqual(['Poster Title', '42%']);
    expect(parsed.artifacts.items).toBe(join(outDir, 'qwen_ocr_items.json'));

    const itemsJson = JSON.parse(readFileSync(join(outDir, 'qwen_ocr_items.json'), 'utf-8')) as { source_image: string };
    expect(itemsJson.source_image).toBe(imagePath);
    const seedJson = JSON.parse(readFileSync(join(outDir, 'qwen_ocr_regions_seed.json'), 'utf-8')) as { layers: Array<{ name: string }> };
    expect(seedJson.layers.some((layer) => layer.name === '10_qwen_text_seed')).toBe(true);
  });

  it('accepts an http image URL when re-parsing a raw Qwen response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yome-chat-ocr-url-'));
    const rawPath = join(dir, 'raw.json');
    writeFileSync(rawPath, JSON.stringify(RAW_QWEN_RESPONSE), 'utf-8');
    vi.stubGlobal('fetch', vi.fn(async () => {
      const png = fakePng(120, 60);
      const body = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }));

    const exit = await runChatSubcommand(['model', 'ocr', 'https://cdn.example.com/design/poster.png'], {
      rawResponse: rawPath,
      json: true,
      local: true,
    });

    expect(exit).toBe(0);
    const parsed = JSON.parse(stdout) as { ok: boolean; image: string; canvas: { width: number; height: number } };
    expect(parsed.ok).toBe(true);
    expect(parsed.image).toBe('https://cdn.example.com/design/poster.png');
    expect(parsed.canvas).toEqual({ width: 120, height: 60, dpi: 96 });
  });

  it('uses the cloud OCR endpoint by default', async () => {
    const calls: Array<{ url: string; body: any; auth: string | null }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url);
      const headers = new Headers(init?.headers);
      calls.push({
        url: requestUrl,
        body: JSON.parse(String(init?.body ?? '{}')),
        auth: headers.get('authorization'),
      });
      return new Response(JSON.stringify({
        ok: true,
        model: 'qwen-vl-ocr-latest',
        image: 'https://cdn.example.com/design/poster.png',
        canvas: { width: 120, height: 60, dpi: 96 },
        metadata: { source: 'dashscope-cloud' },
        items: [{ text: 'Cloud Text', bbox: [1, 2, 3, 4] }],
        text: 'Cloud Text',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const exit = await runChatSubcommand(['model', 'ocr', 'https://cdn.example.com/design/poster.png'], {
      json: true,
      hubBase: 'https://hub.test',
      authToken: 'ytk_test',
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://hub.test/api/cli/chat/model/ocr');
    expect(calls[0]?.auth).toBe('Bearer ytk_test');
    expect(calls[0]?.body.image).toEqual({ url: 'https://cdn.example.com/design/poster.png' });
    const parsed = JSON.parse(stdout) as { ok: boolean; text: string; metadata: { source: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.text).toBe('Cloud Text');
    expect(parsed.metadata.source).toBe('dashscope-cloud');
  });
});
