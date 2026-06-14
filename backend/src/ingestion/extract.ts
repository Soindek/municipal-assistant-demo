import type { FetchedContent } from '@municipal-assistant/shared';

export interface PageText {
  pageNumber: number;
  text: string;
}

export interface ExtractedDocument {
  pages: PageText[];
  /**
   * true if there is practically no extractable text — likely a scanned PDF
   * that would need OCR. (BRIEF point 12: Tesseract `hun` is enough to start.)
   */
  likelyScanned: boolean;
}

const WORD_MIMES = new Set([
  'application/msword', // legacy .doc
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
]);
const ZIP_MIME = 'application/zip';

/** Mime types we can extract text from (PDF, plain text, Word, or a zip of these). */
export function isSupportedMime(mimeType: string): boolean {
  return (
    mimeType === 'application/pdf' ||
    mimeType.startsWith('text/') ||
    WORD_MIMES.has(mimeType) ||
    mimeType === ZIP_MIME
  );
}

/**
 * Strip characters PostgreSQL's TEXT/tsvector cannot store: the NUL byte
 * (code 0) and the other C0 control characters, keeping tab (9), LF (10) and
 * CR (13). Some PDF text layers embed NUL bytes, which would otherwise fail the
 * chunk insert with `invalid byte sequence for encoding "UTF8": 0x00`.
 */
export function sanitizeText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue;
    out += text[i];
  }
  return out;
}

/** Per-page PDF text extraction using the pdfjs-dist legacy (Node) build. */
async function extractPdf(bytes: Uint8Array): Promise<PageText[]> {
  // Dynamic import: pdfjs is ESM and only needs to be loaded during ingestion.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    // Copy: pdfjs transfers (detaches) the ArrayBuffer, and the caller reuses
    // these bytes (e.g. for an OCR fallback on the same document).
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const pages: PageText[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
    pages.push({ pageNumber: p, text });
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

/** Text from a Word document (.doc or .docx) as a single page. */
async function extractWord(bytes: Uint8Array): Promise<PageText[]> {
  // Dynamic import: word-extractor (pure JS, no system deps) handles both the
  // legacy OLE .doc format and the zipped .docx format.
  const WordExtractor = (await import('word-extractor')).default;
  const doc = await new WordExtractor().extract(Buffer.from(bytes));
  const text = [doc.getBody(), doc.getFootnotes(), doc.getEndnotes()]
    .filter(Boolean)
    .join('\n')
    .trim();
  return [{ pageNumber: 1, text }];
}

/**
 * Text from a zip archive: extracts each contained PDF/text entry and
 * concatenates them as consecutive pages. Other entry types (images, CAD) are
 * ignored — if nothing text-bearing is found, the result is empty and the
 * document is tracked as needs_ocr by the pipeline.
 */
async function extractZip(bytes: Uint8Array): Promise<PageText[]> {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(Buffer.from(bytes));
  const pages: PageText[] = [];
  let pageNumber = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.toLowerCase();
    if (name.endsWith('.pdf')) {
      const inner = await extractPdf(new Uint8Array(entry.getData()));
      for (const p of inner) pages.push({ pageNumber: ++pageNumber, text: p.text });
    } else if (name.endsWith('.txt')) {
      pages.push({ pageNumber: ++pageNumber, text: entry.getData().toString('utf-8').trim() });
    }
  }
  return pages;
}

/**
 * Per-page text from fetched content. Handles PDF, plain text, Word (.doc /
 * .docx) and zip archives (extracting the PDF/text entries inside).
 *
 * When `likelyScanned` is true there is no usable text layer; the pipeline then
 * runs the OCR fallback (see ocr.ts) on the page images.
 */
export async function extractText(content: FetchedContent): Promise<ExtractedDocument> {
  let pages: PageText[];
  if (content.mimeType === 'application/pdf') {
    pages = await extractPdf(content.bytes);
  } else if (content.mimeType.startsWith('text/')) {
    pages = [{ pageNumber: 1, text: new TextDecoder('utf-8').decode(content.bytes).trim() }];
  } else if (WORD_MIMES.has(content.mimeType)) {
    pages = await extractWord(content.bytes);
  } else if (content.mimeType === ZIP_MIME) {
    pages = await extractZip(content.bytes);
  } else {
    throw new Error(`Unsupported mime type for text extraction: ${content.mimeType}`);
  }

  const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
  return { pages, likelyScanned: totalChars < 20 };
}
