import type { PageText } from './extract.js';

export interface RawChunk {
  chunkIndex: number;
  content: string;
  /** e.g. "12. §" — from the §-aware chunking, if identifiable. */
  sectionRef: string | null;
  /** The page where the chunk starts. */
  pageNumber: number | null;
  /** Rough estimate (≈ char/4), only for storage/diagnostics. */
  tokenCount: number;
}

export interface ChunkOptions {
  /** Target chunk size in characters (≈ 375 tokens). */
  maxChars?: number;
  /** Overlap between consecutive chunks (to preserve context). */
  overlapChars?: number;
}

// Hungarian legal section marker: "12. §", "12/A. §".
const SECTION_RE = /(\d+(?:\/[A-ZÁÉÍÓÖŐÚÜŰ])?)\.\s*§/;

interface Line {
  text: string;
  pageNumber: number;
}

/** Splits pages into lines (dropping empty lines). */
function toLines(pages: PageText[]): Line[] {
  const lines: Line[] = [];
  for (const page of pages) {
    for (const raw of page.text.split(/\r?\n/)) {
      const text = raw.trim();
      if (text) lines.push({ text, pageNumber: page.pageNumber });
    }
  }
  return lines;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Splits a single overlong line into pieces of at most `maxChars`, preferring a
 * word boundary. PDF text extraction often emits a whole page as one newline-less
 * line; without this, a single line could become a chunk that exceeds the
 * embedding model's hard input limit (text-embedding-3-small: 8192 tokens).
 */
function splitLongLine(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars; // no usable space → hard cut
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Core of the §-aware chunking. Accumulates lines up to the target size, with overlap. */
export function chunkPages(pages: PageText[], opts: ChunkOptions = {}): RawChunk[] {
  const maxChars = opts.maxChars ?? 1500;
  const overlapChars = opts.overlapChars ?? 200;

  // Expand any line longer than the target size so a single newline-less line
  // can never produce an oversized chunk.
  const lines = toLines(pages).flatMap((line) =>
    splitLongLine(line.text, maxChars).map((text) => ({ text, pageNumber: line.pageNumber })),
  );
  const chunks: RawChunk[] = [];

  let buffer = '';
  let bufferPage: number | null = null;
  let bufferSection: string | null = null;
  let currentSection: string | null = null;

  const flush = () => {
    const content = buffer.trim();
    if (!content) return;
    chunks.push({
      chunkIndex: chunks.length,
      content,
      sectionRef: bufferSection,
      pageNumber: bufferPage,
      tokenCount: estimateTokens(content),
    });
  };

  for (const line of lines) {
    // A section marker appearing in the line updates the current section.
    const match = SECTION_RE.exec(line.text);
    if (match) currentSection = `${match[1]}. §`;

    if (buffer === '') {
      bufferPage = line.pageNumber;
      bufferSection = currentSection;
    }
    buffer += (buffer ? '\n' : '') + line.text;

    if (buffer.length >= maxChars) {
      flush();
      // Overlap: carry over the tail of the previous chunk for context.
      const tail = buffer.slice(-overlapChars);
      buffer = tail;
      bufferPage = line.pageNumber;
      bufferSection = currentSection;
    }
  }
  flush();

  // Renumber chunkIndex by the final order (flush already numbers them,
  // but we ensure continuity because of the overlap).
  return chunks.map((c, i) => ({ ...c, chunkIndex: i }));
}
