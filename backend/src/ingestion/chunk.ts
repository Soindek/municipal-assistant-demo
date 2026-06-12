import type { PageText } from './extract.js';

export interface RawChunk {
  chunkIndex: number;
  content: string;
  /** pl. "12. §" — a §-tudatos darabolásból, ha azonosítható. */
  sectionRef: string | null;
  /** Az az oldal, ahol a chunk kezdődik. */
  pageNumber: number | null;
  /** Durva becslés (≈ char/4), csak tárolásra/diagnosztikára. */
  tokenCount: number;
}

export interface ChunkOptions {
  /** Cél chunk-méret karakterben (≈ 375 token). */
  maxChars?: number;
  /** Átfedés az egymást követő chunkok között (kontextus megtartása). */
  overlapChars?: number;
}

// Magyar jogszabályi szakaszjel: "12. §", "12/A. §".
const SECTION_RE = /(\d+(?:\/[A-ZÁÉÍÓÖŐÚÜŰ])?)\.\s*§/;

interface Line {
  text: string;
  pageNumber: number;
}

/** Oldalakból sorokra bont (üres sorokat eldob). */
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

/** A §-tudatos darabolás magja. Sorokat halmoz a cél méretig, átfedéssel. */
export function chunkPages(pages: PageText[], opts: ChunkOptions = {}): RawChunk[] {
  const maxChars = opts.maxChars ?? 1500;
  const overlapChars = opts.overlapChars ?? 200;

  const lines = toLines(pages);
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
    // A sorban megjelenő szakaszjel frissíti az aktuális szekciót.
    const match = SECTION_RE.exec(line.text);
    if (match) currentSection = `${match[1]}. §`;

    if (buffer === '') {
      bufferPage = line.pageNumber;
      bufferSection = currentSection;
    }
    buffer += (buffer ? '\n' : '') + line.text;

    if (buffer.length >= maxChars) {
      flush();
      // Átfedés: az előző chunk farkát visszük tovább a kontextushoz.
      const tail = buffer.slice(-overlapChars);
      buffer = tail;
      bufferPage = line.pageNumber;
      bufferSection = currentSection;
    }
  }
  flush();

  // chunkIndex újraszámozása a végső sorrend szerint (a flush már sorszámoz,
  // de az átfedés miatt biztosítjuk a folytonosságot).
  return chunks.map((c, i) => ({ ...c, chunkIndex: i }));
}
