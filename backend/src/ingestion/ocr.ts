import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createCanvas,
  DOMMatrix,
  ImageData,
  Path2D,
  type Canvas,
  type SKRSContext2D,
} from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker, type Worker } from 'tesseract.js';
import { repoRoot } from '../paths.js';
import type { PageText } from './extract.js';

// pdfjs expects a few browser globals in Node; @napi-rs/canvas provides them.
const globals = globalThis as Record<string, unknown>;
globals.DOMMatrix ??= DOMMatrix;
globals.ImageData ??= ImageData;
globals.Path2D ??= Path2D;

// Resolve the cmap / standard-font folders bundled with pdfjs-dist, as proper
// file:// URLs WITH a trailing slash (pdfjs rejects OS-separator paths on Windows).
const requireFromHere = createRequire(import.meta.url);
const pdfjsDir = dirname(requireFromHere.resolve('pdfjs-dist/package.json'));
const CMAP_URL = `${pathToFileURL(join(pdfjsDir, 'cmaps')).href}/`;
const STANDARD_FONTS_URL = `${pathToFileURL(join(pdfjsDir, 'standard_fonts')).href}/`;

interface CanvasAndContext {
  canvas: Canvas | null;
  context: SKRSContext2D | null;
}

/** pdfjs CanvasFactory backed by @napi-rs/canvas (prebuilt, no system deps). */
class NapiCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    const canvas = createCanvas(Math.ceil(width) || 1, Math.ceil(height) || 1);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(cc: CanvasAndContext, width: number, height: number): void {
    if (cc.canvas) {
      cc.canvas.width = Math.ceil(width) || 1;
      cc.canvas.height = Math.ceil(height) || 1;
    }
  }
  destroy(cc: CanvasAndContext): void {
    if (cc.canvas) {
      cc.canvas.width = 0;
      cc.canvas.height = 0;
    }
    cc.canvas = null;
    cc.context = null;
  }
}

const CACHE_DIR = resolveCacheDir();
function resolveCacheDir(): string {
  // tesseract.js caches the WASM core + Hungarian traineddata here. Gitignored.
  return join(repoRoot, 'data', 'ocr-cache');
}

export interface OcrOptions {
  /** Render scale before OCR; higher = better accuracy but slower/more memory. */
  viewportScale?: number;
  /** Safety cap on pages OCR'd per document (0 = no cap). */
  maxPages?: number;
}

let workerPromise: Promise<Worker> | null = null;
async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('hun', undefined, { cachePath: CACHE_DIR });
  }
  return workerPromise;
}

/** Renders each PDF page to a PNG buffer at the given scale. */
async function renderPagesToPng(
  bytes: Uint8Array,
  scale: number,
  maxPages: number,
): Promise<{ pageNumber: number; png: Buffer }[]> {
  const doc = await pdfjs.getDocument({
    // Copy: pdfjs detaches the input ArrayBuffer; keep the caller's bytes intact.
    data: new Uint8Array(bytes),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONTS_URL,
    CanvasFactory: NapiCanvasFactory,
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;

  const factory = new NapiCanvasFactory();
  const limit = maxPages > 0 ? Math.min(maxPages, doc.numPages) : doc.numPages;
  const out: { pageNumber: number; png: Buffer }[] = [];

  for (let p = 1; p <= limit; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale });
    const cc = factory.create(viewport.width, viewport.height);
    // pdfjs wants a DOM CanvasRenderingContext2D; @napi-rs/canvas's context is
    // compatible at runtime. Cast via the method signature (no DOM lib in Node).
    const renderParams = { canvasContext: cc.context, viewport } as unknown as Parameters<
      typeof page.render
    >[0];
    await page.render(renderParams).promise;
    out.push({ pageNumber: p, png: cc.canvas!.toBuffer('image/png') });
    page.cleanup();
    factory.destroy(cc);
  }

  await doc.destroy();
  return out;
}

/**
 * OCRs a (likely scanned) PDF: renders each page to a high-res PNG, then runs
 * Tesseract with the Hungarian model. Quality on signed/stamped/skewed municipal
 * scans is imperfect by nature — the goal is searchable, citable text, not a
 * perfect transcript.
 */
export async function ocrPdf(bytes: Uint8Array, opts: OcrOptions = {}): Promise<PageText[]> {
  const viewportScale = opts.viewportScale ?? 3;
  const maxPages = opts.maxPages ?? 0;

  const pages = await renderPagesToPng(bytes, viewportScale, maxPages);
  const worker = await getWorker();

  const out: PageText[] = [];
  for (const { pageNumber, png } of pages) {
    const { data } = await worker.recognize(png);
    out.push({ pageNumber, text: data.text.trim() });
  }
  return out;
}

/** Releases the OCR worker (call at the end of a batch/CLI run). */
export async function terminateOcr(): Promise<void> {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
    workerPromise = null;
  }
}
