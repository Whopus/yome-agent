// `yome chat ...` subcommand router.
//
// `chat model` is intentionally a namespace instead of a single action. The
// first concrete operation is OCR, and future model-backed chat utilities can
// sit next to it without overloading the media-facing `chat show/imagine`
// command shape used by the cloud agent.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readAuthState } from '../yomeSkills/auth.js';
import { getHubBase } from '../yomeSkills/login.js';

const DEFAULT_QWEN_OCR_MODEL = 'qwen-vl-ocr-latest';
const DEFAULT_QWEN_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const IMAGE_FETCH_TIMEOUT_MS = 60_000;
const QWEN_OCR_TIMEOUT_MS = 180_000;

export interface ChatCliFlags {
  json?: boolean;
  out?: string;
  model?: string;
  rawResponse?: string;
  endpoint?: string;
  settings?: string;
  minPixels?: string;
  maxPixels?: string;
  enableRotate?: boolean;
  margin?: string;
  dpi?: string;
  local?: boolean;
  hubBase?: string;
  /** Test seam. Not wired to CLI flags. */
  authToken?: string;
  /** Test seam. Not wired to CLI flags. */
  fetcher?: typeof fetch;
}

interface ImageSize {
  width: number;
  height: number;
}

interface ImageSource {
  source: string;
  data: Buffer;
  mime: string;
}

interface OcrItem {
  text: string;
  bbox?: [number, number, number, number];
  role?: string;
  rotate_rect?: unknown;
  location?: unknown;
}

interface OcrResult {
  model: string;
  image: string;
  canvas?: { width: number; height: number; dpi: number };
  metadata: Record<string, unknown>;
  rawResponse: unknown;
  items: OcrItem[];
  text: string;
  artifacts?: Record<string, string>;
}

export async function runChatSubcommand(args: string[], flags: ChatCliFlags): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case 'model':
      return runChatModel(args.slice(1), flags);
    case undefined:
    case 'help':
    case '--help':
      printChatHelp();
      return 0;
    default:
      console.error(`Unknown subcommand: yome chat ${sub}`);
      printChatHelp();
      return 2;
  }
}

function printChatHelp(): void {
  console.log(`Usage: yome chat <subcommand>

  model ocr <image> [--out=<dir>]      Run Qwen OCR on a local image path or http(s) URL.
                                       Default: cloud call through yome.work.
                                       Without --out, prints recognized text.
                                       With --out, writes qwen_ocr_* artifacts
                                       usable as a poster-layers bootstrap.

Options for model ocr:
  --json                               Print machine-readable JSON.
  --model=<name>                       DashScope model (default: ${DEFAULT_QWEN_OCR_MODEL}).
  --local                              Call DashScope directly from this machine.
  --raw-response=<file>                Local-only: re-parse an existing raw Qwen response instead of calling the API.
  --endpoint=<url>                     Local-only: DashScope endpoint override.
  --settings=<file>                    Local-only: settings file for apiKey discovery (default ~/.yome/settings.json).
  --min-pixels=<n>                     Qwen min_pixels (default 3072).
  --max-pixels=<n>                     Qwen max_pixels (default 8388608).
  --enable-rotate                      Ask Qwen OCR to rotate pages when useful.
  --margin=<px>                        Margin added around OCR boxes (default 4).
  --dpi=<n>                            DPI recorded in generated region seed (default 96).

Key lookup:
  Cloud mode uses the server's DASHSCOPE_API_KEY. Local mode reads DASHSCOPE_API_KEY first,
  then the first DashScope Qwen custom model in ~/.yome/settings.json.

Examples:
  yome chat model ocr ~/Desktop/poster.png
  yome chat model ocr https://example.com/poster.png
  yome chat model ocr ~/Desktop/poster.png --out=./poster_ocr
  yome chat model ocr ~/Desktop/poster.png --local
  yome chat model ocr ~/Desktop/poster.png --raw-response=./poster_ocr/qwen_ocr_raw_response.json --json
`);
}

async function runChatModel(args: string[], flags: ChatCliFlags): Promise<number> {
  const action = args[0];
  switch (action) {
    case 'ocr':
      return runQwenOcr(args.slice(1), flags);
    case undefined:
    case 'help':
    case '--help':
      printChatModelHelp();
      return 0;
    default:
      console.error(`Unknown subcommand: yome chat model ${action}`);
      printChatModelHelp();
      return 2;
  }
}

function printChatModelHelp(): void {
  console.log(`Usage: yome chat model <subcommand>

  ocr <image> [--out=<dir>]            Run Qwen OCR on a local image or URL and print text / write artifacts.
                                       Defaults to yome.work cloud. Use --local for direct DashScope.

Examples:
  yome chat model ocr ~/Desktop/poster.png
  yome chat model ocr https://example.com/poster.png
  yome chat model ocr ~/Desktop/poster.png --out=./poster_ocr
`);
}

async function runQwenOcr(args: string[], flags: ChatCliFlags): Promise<number> {
  const imageArg = args[0];
  if (!imageArg) {
    console.error('Usage: yome chat model ocr <image> [--out=<dir>] [--json]');
    return 2;
  }

  try {
    const options = {
      model: flags.model || DEFAULT_QWEN_OCR_MODEL,
      endpoint: flags.endpoint || DEFAULT_QWEN_ENDPOINT,
      settingsPath: flags.settings ? resolveTilde(flags.settings) : join(homedir(), '.yome', 'settings.json'),
      rawResponsePath: flags.rawResponse ? resolveTilde(flags.rawResponse) : undefined,
      minPixels: parseIntegerFlag(flags.minPixels, 3072, '--min-pixels'),
      maxPixels: parseIntegerFlag(flags.maxPixels, 8_388_608, '--max-pixels'),
      enableRotate: !!flags.enableRotate,
      margin: parseIntegerFlag(flags.margin, 4, '--margin'),
      dpi: parseIntegerFlag(flags.dpi, 96, '--dpi'),
    };
    const useLocal = !!flags.local || !!options.rawResponsePath;
    const result = useLocal
      ? await qwenOcrLocal(imageArg, options)
      : await qwenOcrCloud(imageArg, {
          ...options,
          out: flags.out,
          hubBase: flags.hubBase,
          authToken: flags.authToken,
          fetcher: flags.fetcher,
        });

    if (flags.out) {
      result.artifacts = writeQwenOcrArtifacts(resolveTilde(flags.out), result);
    }

    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: true, ...withoutRawResponse(result) }, null, 2) + '\n');
      return 0;
    }

    printOcrSummary(result);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + '\n');
    } else {
      console.error(`✗ ${message}`);
    }
    return 1;
  }
}

async function qwenOcrCloud(imageArg: string, opts: {
  model: string;
  minPixels: number;
  maxPixels: number;
  enableRotate: boolean;
  margin: number;
  dpi: number;
  out?: string;
  hubBase?: string;
  authToken?: string;
  fetcher?: typeof fetch;
}): Promise<OcrResult> {
  const authToken = opts.authToken ?? readAuthState()?.yome_token;
  if (!authToken) {
    throw new Error('Cloud OCR requires `yome login`. Run `yome login`, or use --local for direct DashScope.');
  }
  const fetcher = opts.fetcher ?? fetch;
  const hubBase = (opts.hubBase ?? getHubBase()).replace(/\/+$/, '');
  const image = isHttpUrl(imageArg)
    ? { url: imageArg }
    : localImagePayload(imageArg);

  const resp = await fetchWithTimeout(`${hubBase}/api/cli/chat/model/ocr`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      image,
      model: opts.model,
      minPixels: opts.minPixels,
      maxPixels: opts.maxPixels,
      enableRotate: opts.enableRotate,
      margin: opts.margin,
      dpi: opts.dpi,
      includeRaw: Boolean(opts.out),
    }),
  }, QWEN_OCR_TIMEOUT_MS, fetcher);

  const text = await resp.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Cloud OCR returned non-JSON response: ${text.slice(0, 500)}`);
  }
  if (!resp.ok || !parsed?.ok) {
    const suffix = resp.status === 401 ? ' Run `yome login` and retry.' : '';
    throw new Error(`Cloud OCR failed${resp.status ? ` HTTP ${resp.status}` : ''}: ${parsed?.error ?? text.slice(0, 500)}${suffix}`);
  }

  return {
    model: String(parsed.model || opts.model),
    image: String(parsed.image || imageArg),
    ...(parsed.canvas ? { canvas: parsed.canvas } : {}),
    metadata: isRecord(parsed.metadata) ? parsed.metadata : {},
    rawResponse: parsed.rawResponse,
    items: Array.isArray(parsed.items) ? parsed.items : [],
    text: typeof parsed.text === 'string' ? parsed.text : '',
  };
}

async function qwenOcrLocal(imageArg: string, opts: {
  model: string;
  endpoint: string;
  settingsPath: string;
  rawResponsePath?: string;
  minPixels: number;
  maxPixels: number;
  enableRotate: boolean;
  margin: number;
  dpi: number;
}): Promise<OcrResult> {
  const imageSource = await loadImageSource(imageArg);
  return qwenOcr({
    imageSource,
    model: opts.model,
    endpoint: opts.endpoint,
    settingsPath: opts.settingsPath,
    rawResponsePath: opts.rawResponsePath,
    minPixels: opts.minPixels,
    maxPixels: opts.maxPixels,
    enableRotate: opts.enableRotate,
    margin: opts.margin,
    dpi: opts.dpi,
  });
}

function printOcrSummary(result: OcrResult): void {
  console.log(`Detected ${result.items.length} text item${result.items.length === 1 ? '' : 's'} with ${result.model}.`);
  if (result.canvas) console.log(`Canvas: ${result.canvas.width} x ${result.canvas.height}px`);
  if (result.artifacts) {
    console.log('Artifacts:');
    for (const [name, path] of Object.entries(result.artifacts)) {
      console.log(`  ${name}: ${path}`);
    }
  }
  if (result.text.trim()) {
    console.log('');
    console.log(result.text.trim());
  }
}

function withoutRawResponse(result: OcrResult): Omit<OcrResult, 'rawResponse'> {
  const { rawResponse: _rawResponse, ...rest } = result;
  return rest;
}

async function qwenOcr(opts: {
  imageSource: ImageSource;
  model: string;
  endpoint: string;
  settingsPath: string;
  rawResponsePath?: string;
  minPixels: number;
  maxPixels: number;
  enableRotate: boolean;
  margin: number;
  dpi: number;
}): Promise<OcrResult> {
  const size = readImageSize(opts.imageSource.data);

  const rawResponse = opts.rawResponsePath
    ? JSON.parse(readFileSync(opts.rawResponsePath, 'utf-8'))
    : await callQwenOcr({
        imageSource: opts.imageSource,
        apiKey: loadDashScopeKey(opts.settingsPath),
        model: opts.model,
        endpoint: opts.endpoint,
        minPixels: opts.minPixels,
        maxPixels: opts.maxPixels,
        enableRotate: opts.enableRotate,
      });

  const rawItems = processedTextItems(rawResponse) || wordsInfoItems(rawResponse);
  if (rawItems.length === 0) {
    throw new Error('Qwen OCR response did not contain parseable text items.');
  }

  const { items, metadata } = normalizeItems(rawItems, size, opts.margin);
  if (items.length === 0) {
    throw new Error('Qwen OCR items did not contain usable text.');
  }

  return {
    model: opts.model,
    image: opts.imageSource.source,
    ...(size ? { canvas: { width: size.width, height: size.height, dpi: opts.dpi } } : {}),
    metadata: {
      ...metadata,
      margin: opts.margin,
      min_pixels: opts.minPixels,
      max_pixels: opts.maxPixels,
      enable_rotate: opts.enableRotate,
      source: opts.rawResponsePath ? 'raw-response' : 'dashscope',
    },
    rawResponse,
    items,
    text: items.map((item) => item.text).join('\n'),
  };
}

async function callQwenOcr(opts: {
  imageSource: ImageSource;
  apiKey: string;
  model: string;
  endpoint: string;
  minPixels: number;
  maxPixels: number;
  enableRotate: boolean;
}): Promise<unknown> {
  const payload = {
    model: opts.model,
    input: {
      messages: [
        {
          role: 'user',
          content: [
            {
              image: imageDataUrl(opts.imageSource),
              min_pixels: opts.minPixels,
              max_pixels: opts.maxPixels,
              enable_rotate: opts.enableRotate,
            },
          ],
        },
      ],
    },
    parameters: {
      ocr_options: { task: 'advanced_recognition' },
      temperature: 0.01,
      top_p: 0.001,
    },
  };

  const response = await fetchWithTimeout(opts.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
  }, QWEN_OCR_TIMEOUT_MS);

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Qwen OCR HTTP ${response.status}: ${body.slice(0, 2000)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Qwen OCR returned non-JSON response: ${body.slice(0, 500)}`);
  }
}

function writeQwenOcrArtifacts(outDir: string, result: OcrResult): Record<string, string> {
  mkdirSync(outDir, { recursive: true });

  const artifacts: Record<string, string> = {};
  if (result.rawResponse !== undefined) {
    const rawPath = join(outDir, 'qwen_ocr_raw_response.json');
    writeJson(rawPath, result.rawResponse);
    artifacts.rawResponse = rawPath;
  }

  const itemsPath = join(outDir, 'qwen_ocr_items.json');
  writeJson(itemsPath, {
    source_image: result.image,
    ...(result.canvas ? { canvas: result.canvas } : {}),
    metadata: result.metadata,
    items: result.items,
  });
  artifacts.items = itemsPath;

  const textPath = join(outDir, 'qwen_ocr_text.txt');
  writeFileSync(textPath, result.text + (result.text.endsWith('\n') ? '' : '\n'), 'utf-8');
  artifacts.text = textPath;

  if (result.canvas) {
    const seedPath = join(outDir, 'qwen_ocr_regions_seed.json');
    writeJson(seedPath, buildPosterRegionsSeed(result));
    artifacts.regionsSeed = seedPath;
  }

  return artifacts;
}

function buildPosterRegionsSeed(result: OcrResult): unknown {
  const bboxes = result.items
    .map((item) => item.bbox)
    .filter((bbox): bbox is [number, number, number, number] => Array.isArray(bbox));

  return {
    project_name: `${projectStemFromSource(result.image)}_qwen_ocr_seed`,
    meta: {
      source_canvas: result.canvas ? `${result.canvas.width} x ${result.canvas.height} px` : undefined,
      generated_by: 'yome chat model ocr',
      model: result.model,
      note: [
        'OCR bboxes are a bootstrap for review, not a final design reconstruction.',
        'This CLI seed does not classify text color; inspect the image and adjust selectors/layers before delivery.',
      ].join(' '),
      ocr_scaling: result.metadata,
    },
    canvas: {
      dpi: result.canvas?.dpi ?? 96,
      white: [255, 255, 255, 255],
    },
    inpaint: {
      radius: 4,
      method: 'telea',
      post: { dilate: 2, blur: 0 },
      use_layers: ['10_qwen_text_seed'],
    },
    layers: [
      {
        name: '00_base_white',
        kind: 'solid',
        source: 'solid',
        color: [255, 255, 255, 255],
        z: 0,
      },
      {
        name: '01_background_text_removed_approx',
        kind: 'background_inpaint',
        source: 'inpainted',
        z: 10,
        opacity: 1.0,
      },
      {
        name: '10_qwen_text_seed',
        kind: 'color_mask',
        source: 'original',
        z: 80,
        use_for_inpaint_mask: true,
        bboxes,
        selector: { preset: 'dark', luma_max: 190, alpha_min: 1 },
        post: { close: 1, dilate: 1, min_area: 3, blur: 0.7 },
      },
    ],
  };
}

function loadDashScopeKey(settingsPath: string): string {
  const envKey = process.env.DASHSCOPE_API_KEY;
  if (envKey) return envKey;

  if (!existsSync(settingsPath)) {
    throw new Error(`DASHSCOPE_API_KEY is not set and no settings file was found at ${settingsPath}`);
  }

  const data = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
    customModels?: Array<{ apiKey?: string; baseUrl?: string; model?: string; id?: string }>;
  };
  for (const model of data.customModels ?? []) {
    const apiKey = String(model.apiKey || '');
    const baseUrl = String(model.baseUrl || '');
    const modelName = String(model.model || model.id || '');
    if (apiKey && baseUrl.includes('dashscope') && modelName.startsWith('qwen')) {
      return apiKey;
    }
  }
  throw new Error(`No DashScope Qwen apiKey found in ${settingsPath}`);
}

async function loadImageSource(raw: string): Promise<ImageSource> {
  if (isHttpUrl(raw)) {
    const response = await fetchWithTimeout(raw, undefined, IMAGE_FETCH_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(`Image URL returned HTTP ${response.status}: ${raw}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const data = Buffer.from(arrayBuffer);
    if (data.length === 0) {
      throw new Error(`Image URL returned an empty body: ${raw}`);
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    return {
      source: raw,
      data,
      mime: contentType && contentType.startsWith('image/') ? contentType : mimeFromPath(raw),
    };
  }

  const path = resolveTilde(raw);
  if (!existsSync(path)) {
    throw new Error(`Image not found: ${path}`);
  }
  return {
    source: resolve(path),
    data: readFileSync(path),
    mime: mimeFromPath(path),
  };
}

async function fetchWithTimeout(url: string, init: RequestInit | undefined, timeoutMs: number, fetcher: typeof fetch = fetch): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function processedTextItems(response: unknown): Array<Record<string, unknown>> | null {
  const candidates: string[] = [];
  for (const obj of iterObjects(response)) {
    const processed = obj.processed_text;
    if (typeof processed === 'string' && processed.trim()) candidates.push(processed);
    const text = obj.text;
    if (typeof text === 'string' && text.includes('rotate_rect')) candidates.push(text);
  }

  for (const text of candidates) {
    try {
      let parsed = extractJsonText(text);
      if (isRecord(parsed)) {
        parsed = parsed.items ?? parsed.words ?? parsed.data;
      }
      if (Array.isArray(parsed)) {
        const items = parsed.filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.text === 'string' && item.text.trim().length > 0);
        if (items.length > 0) return items;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function wordsInfoItems(response: unknown): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const obj of iterObjects(response)) {
    const wordsInfo = obj.words_info;
    if (!Array.isArray(wordsInfo)) continue;
    for (const item of wordsInfo) {
      if (isRecord(item) && typeof item.text === 'string' && item.text.trim()) {
        items.push(item);
      }
    }
  }
  return items;
}

function normalizeItems(rawItems: Array<Record<string, unknown>>, canvas: ImageSize | undefined, margin: number): {
  items: OcrItem[];
  metadata: Record<string, unknown>;
} {
  const [autoXScale, autoYScale] = canvas ? autoScales(rawItems, canvas) : [1, 1];
  const seen = new Set<string>();
  const items: OcrItem[] = [];

  for (const raw of rawItems) {
    const text = String(raw.text || '').trim();
    if (!text) continue;

    const bbox = canvas ? itemBBox(raw, canvas, autoXScale, autoYScale, margin) : undefined;
    const key = `${text}:${bbox ? bbox.join(',') : items.length}`;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      text,
      ...(bbox ? { bbox, role: roleForItem(text, bbox) } : {}),
      ...(raw.rotate_rect !== undefined ? { rotate_rect: raw.rotate_rect } : {}),
      ...(raw.location !== undefined ? { location: raw.location } : {}),
    });
  }

  return {
    items,
    metadata: {
      x_scale: autoXScale,
      y_scale: autoYScale,
      auto_x_scale: autoXScale,
      auto_y_scale: autoYScale,
      bbox_source: canvas ? 'rotate_rect/location' : 'text-only',
    },
  };
}

function rawAxisBoxFromItem(item: Record<string, unknown>): [number, number, number, number] | null {
  const location = toNumberArray(item.location);
  if (location && location.length >= 8 && location.slice(0, 8).some((v) => v !== 0)) {
    const xs = [location[0]!, location[2]!, location[4]!, location[6]!];
    const ys = [location[1]!, location[3]!, location[5]!, location[7]!];
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  const rotateRect = toNumberArray(item.rotate_rect);
  if (!rotateRect || rotateRect.length < 5) return null;
  const [cx, cy, rectW, rectH, rawAngle] = rotateRect as [number, number, number, number, number];
  const angle = Math.abs(rawAngle) % 180;
  const [axisW, axisH] = angle >= 45 && angle <= 135 ? [rectH, rectW] : [rectW, rectH];
  return [cx - axisW / 2, cy - axisH / 2, cx + axisW / 2, cy + axisH / 2];
}

function autoScales(items: Array<Record<string, unknown>>, canvas: ImageSize): [number, number] {
  const boxes = items
    .map(rawAxisBoxFromItem)
    .filter((box): box is [number, number, number, number] => box !== null);
  if (boxes.length === 0) return [1, 1];

  const maxX = Math.max(...boxes.map((box) => box[2]));
  const maxY = Math.max(...boxes.map((box) => box[3]));
  let xScale = 1;
  let yScale = 1;
  if (canvas.width > canvas.height && maxX <= canvas.height * 1.10) {
    xScale = canvas.width / canvas.height;
  }
  if (canvas.height > canvas.width && maxY <= canvas.width * 1.10) {
    yScale = canvas.height / canvas.width;
  }
  return [xScale, yScale];
}

function itemBBox(
  item: Record<string, unknown>,
  canvas: ImageSize,
  xScale: number,
  yScale: number,
  margin: number,
): [number, number, number, number] | undefined {
  const raw = rawAxisBoxFromItem(item);
  if (!raw) return undefined;
  const bbox = clampBBox(
    [raw[0] * xScale, raw[1] * yScale, raw[2] * xScale, raw[3] * yScale],
    canvas,
    margin,
  );
  if (bbox[2] - bbox[0] <= 1 || bbox[3] - bbox[1] <= 1) return undefined;
  return bbox;
}

function clampBBox(box: [number, number, number, number], canvas: ImageSize, margin: number): [number, number, number, number] {
  let [x1, y1, x2, y2] = box;
  x1 = Math.max(0, Math.min(canvas.width, Math.floor(x1) - margin));
  y1 = Math.max(0, Math.min(canvas.height, Math.floor(y1) - margin));
  x2 = Math.max(0, Math.min(canvas.width, Math.ceil(x2) + margin));
  y2 = Math.max(0, Math.min(canvas.height, Math.ceil(y2) + margin));
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  return [x1, y1, x2, y2];
}

function roleForItem(text: string, bbox: [number, number, number, number]): string {
  const [x1, y1, x2, y2] = bbox;
  const height = y2 - y1;
  const width = x2 - x1;
  if (y1 < 100 && width > 250) return 'header';
  if (height >= 55 || (width > 250 && y1 < 280)) return 'title';
  if (/\d/.test(text) && /[%+BK]/.test(text)) return 'metric';
  if (text.length <= 12 && height <= 40) return 'label';
  return 'body';
}

function extractJsonText(text: string): unknown {
  let stripped = text.trim();
  if (stripped.startsWith('```')) {
    let lines = stripped.split(/\r?\n/);
    if (lines[0]?.trim().startsWith('```')) lines = lines.slice(1);
    if (lines[lines.length - 1]?.trim().startsWith('```')) lines = lines.slice(0, -1);
    stripped = lines.join('\n').trim();
  }
  const starts = [stripped.indexOf('{'), stripped.indexOf('[')].filter((idx) => idx >= 0);
  if (starts.length > 0) stripped = stripped.slice(Math.min(...starts));
  const end = Math.max(stripped.lastIndexOf('}'), stripped.lastIndexOf(']'));
  if (end >= 0) stripped = stripped.slice(0, end + 1);
  return JSON.parse(stripped);
}

function* iterObjects(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* iterObjects(item);
    return;
  }
  if (!isRecord(value)) return;
  yield value;
  for (const child of Object.values(value)) yield* iterObjects(child);
}

function readImageSize(buf: Buffer): ImageSize | undefined {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    return readJpegSize(buf);
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return readWebpSize(buf);
  }
  return undefined;
}

function readJpegSize(buf: Buffer): ImageSize | undefined {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buf.length) return undefined;
    const length = buf.readUInt16BE(offset);
    if (length < 2 || offset + length > buf.length) return undefined;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      return { height: buf.readUInt16BE(offset + 3), width: buf.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

function readWebpSize(buf: Buffer): ImageSize | undefined {
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && buf.length >= 30) {
    return {
      width: 1 + readUInt24LE(buf, 24),
      height: 1 + readUInt24LE(buf, 27),
    };
  }
  if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
    const b0 = buf[21]!;
    const b1 = buf[22]!;
    const b2 = buf[23]!;
    const b3 = buf[24]!;
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  return undefined;
}

function readUInt24LE(buf: Buffer, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8) | (buf[offset + 2]! << 16);
}

function imageDataUrl(source: ImageSource): string {
  return `data:${source.mime};base64,${source.data.toString('base64')}`;
}

function localImagePayload(raw: string): { dataUrl: string; source: string } {
  const path = resolveTilde(raw);
  if (!existsSync(path)) {
    throw new Error(`Image not found: ${path}`);
  }
  const data = readFileSync(path);
  const source = resolve(path);
  return {
    source,
    dataUrl: `data:${mimeFromPath(path)};base64,${data.toString('base64')}`,
  };
}

function mimeFromPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    default:
      return 'image/png';
  }
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function filenameFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const name = basename(url.pathname);
    return name || 'image.png';
  } catch {
    return 'image.png';
  }
}

function projectStemFromSource(source: string): string {
  if (isHttpUrl(source)) {
    const file = filenameFromUrl(source);
    return basename(file, extname(file)) || 'qwen_ocr';
  }
  return basename(source, extname(source)) || 'qwen_ocr';
}

function toNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const nums = value.map((v) => Number(v));
  if (nums.some((v) => !Number.isFinite(v))) return null;
  return nums;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseIntegerFlag(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function resolveTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(path);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}
