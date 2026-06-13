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

/**
 * Per-page text from fetched content. Handles PDF and plain text.
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
  } else {
    throw new Error(`Unsupported mime type for text extraction: ${content.mimeType}`);
  }

  const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
  return { pages, likelyScanned: totalChars < 20 };
}
