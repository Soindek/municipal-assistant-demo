import type { FetchedContent } from '@municipal-assistant/shared';

export interface PageText {
  pageNumber: number;
  text: string;
}

export interface ExtractedDocument {
  pages: PageText[];
  /**
   * true, ha gyakorlatilag nincs kinyerhető szöveg — valószínűleg szkennelt PDF,
   * ahol OCR kellene. (BRIEF 12. pont: kezdésnek Tesseract `hun` elég.)
   */
  likelyScanned: boolean;
}

/** PDF szövegkinyerés oldalanként, a pdfjs-dist legacy (Node) buildjével. */
async function extractPdf(bytes: Uint8Array): Promise<PageText[]> {
  // Dinamikus import: a pdfjs ESM, és csak ingestionkor kell betölteni.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: bytes,
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
 * Letöltött tartalomból oldalankénti szöveg. PDF-et és sima szöveget kezel.
 *
 * TODO (OCR-fallback, BRIEF 3./5./12. pont): ha `likelyScanned`, futtassunk
 * Tesseract `hun` OCR-t az oldalképeken. Ez a bekötési pont — a pipeline már
 * jelez, ha egy dokumentum szkenneltnek tűnik.
 */
export async function extractText(content: FetchedContent): Promise<ExtractedDocument> {
  let pages: PageText[];
  if (content.mimeType === 'application/pdf') {
    pages = await extractPdf(content.bytes);
  } else if (content.mimeType.startsWith('text/')) {
    pages = [{ pageNumber: 1, text: new TextDecoder('utf-8').decode(content.bytes).trim() }];
  } else {
    throw new Error(`Nem támogatott mime-típus a szövegkinyeréshez: ${content.mimeType}`);
  }

  const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
  return { pages, likelyScanned: totalChars < 20 };
}
