import type {
  DocumentSource,
  DocumentSourceContext,
  SourceLogger,
} from '@municipal-assistant/shared';
import type { EmbeddingClient } from '../llm/types.js';
import { findByExternalId, upsertDocument } from '../db/repositories/documents.js';
import {
  deleteChunksForDocument,
  replaceChunks,
  type ChunkInput,
} from '../db/repositories/chunks.js';
import { chunkPages } from './chunk.js';
import { buildEmbedText } from './embed-text.js';
import { extractText, isSupportedMime, sanitizeText, type PageText } from './extract.js';

export interface IngestStats {
  processed: number;
  /** Of `processed`, how many were recovered via OCR. */
  ocred: number;
  skipped: number;
  scanned: number;
  /** Fetched, but the file type can't be text-extracted (e.g. xlsx, CAD). */
  unsupported: number;
  failed: number;
}

export interface PipelineDeps {
  tenantId: string;
  embedding: EmbeddingClient;
  logger: SourceLogger;
  signal?: AbortSignal;
  /**
   * Optional OCR hook for scanned PDFs. When provided, likely-scanned documents
   * are OCR'd and ingested; when absent, they are marked needs_ocr and skipped.
   */
  ocr?: (bytes: Uint8Array) => Promise<PageText[]>;
  /**
   * Optional content-based category refinement: given the title and a text
   * sample, returns a category key (falls back to the adapter's guess). Only
   * applied to documents that have extractable/OCR'd text.
   */
  categorize?: (title: string, text: string, fallback: string) => string;
}

/** Embed in batches so we don't exceed the provider's request limits. */
async function embedInBatches(
  client: EmbeddingClient,
  texts: string[],
  signal?: AbortSignal,
  batchSize = 96,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    out.push(...(await client.embed(texts.slice(i, i + batchSize), signal)));
  }
  return out;
}

/**
 * Generic ingestion pipeline for a single source:
 *   list → (skip based on change token) → fetch → extract (OCR fallback for
 *   scanned PDFs) → §-aware chunking → embedding → upsert.
 *
 * It knows nothing about the source beyond what the DocumentSource interface
 * provides (BRIEF points 3/4).
 */
export async function ingestSource(
  source: DocumentSource,
  deps: PipelineDeps,
): Promise<IngestStats> {
  const stats: IngestStats = {
    processed: 0,
    ocred: 0,
    skipped: 0,
    scanned: 0,
    unsupported: 0,
    failed: 0,
  };
  const ctx: DocumentSourceContext = {
    tenantId: deps.tenantId,
    logger: deps.logger,
    signal: deps.signal,
  };

  for await (const doc of source.list(ctx)) {
    try {
      // Change detection: skip only ACTIVE documents whose token is unchanged.
      // needs_ocr (and other non-active) docs are always reprocessed — so once an
      // OCR hook is available, previously-skipped scans get picked up.
      const existing = await findByExternalId(source.name, doc.externalId);
      if (
        existing &&
        existing.status === 'active' &&
        doc.changeToken !== null &&
        existing.changeToken === doc.changeToken
      ) {
        deps.logger.info(`Skipped (unchanged): ${doc.title}`);
        stats.skipped++;
        continue;
      }

      const fetched = await source.fetch(doc, ctx);

      // Skip file types we can't extract text from (spreadsheets, CAD, images
      // that aren't PDFs). A deliberate, tracked skip rather than a hard error.
      if (!isSupportedMime(fetched.mimeType)) {
        deps.logger.warn(`Unsupported file type, skipping: ${doc.title} (${fetched.mimeType})`);
        stats.unsupported++;
        continue;
      }

      const extracted = await extractText(fetched);

      // Common document metadata for upsert (status set per-branch below).
      const docFields = {
        sourceName: source.name,
        externalId: doc.externalId,
        title: doc.title,
        category: doc.category,
        sourceUrl: doc.sourceUrl,
        mimeType: doc.mimeType,
        changeToken: doc.changeToken,
        publishedAt: doc.publishedAt ?? null,
      };

      // Decide the page set: extracted text, or OCR for scanned PDFs.
      let pages = extracted.pages;
      let viaOcr = false;
      if (extracted.likelyScanned) {
        // OCR only makes sense on actual PDF page images. For other types with
        // no extractable text (a scanned PDF inside a zip, an empty Word doc),
        // running OCR on the raw bytes would fail — mark needs_ocr instead.
        if (!deps.ocr || fetched.mimeType !== 'application/pdf') {
          // No OCR available: mark needs_ocr (no chunks) so the corpus stays clean
          // but the doc is tracked and re-indexable once OCR is enabled.
          const documentId = await upsertDocument({ ...docFields, status: 'needs_ocr' });
          await deleteChunksForDocument(documentId);
          deps.logger.warn(`No extractable text — marked needs_ocr: ${doc.title}`);
          stats.scanned++;
          continue;
        }
        deps.logger.info(`Scanned — running OCR: ${doc.title}`);
        pages = await deps.ocr(fetched.bytes);
        viaOcr = true;
      }

      // Strip control/NUL bytes (from either the PDF text layer or OCR) before
      // chunking, so the stored content and embeddings stay clean and the
      // Postgres insert can't fail on an invalid byte sequence.
      pages = pages.map((p) => ({ ...p, text: sanitizeText(p.text) }));

      const rawChunks = chunkPages(pages);
      if (rawChunks.length === 0) {
        // Even OCR found nothing usable → keep it tracked as needs_ocr.
        const documentId = await upsertDocument({ ...docFields, status: 'needs_ocr' });
        await deleteChunksForDocument(documentId);
        deps.logger.warn(
          `No extractable text${viaOcr ? ' (after OCR)' : ''} — needs_ocr: ${doc.title}`,
        );
        stats.scanned++;
        continue;
      }

      // Refine the category from the actual (extracted/OCR'd) text.
      if (deps.categorize) {
        const sample = pages
          .map((p) => p.text)
          .join('\n')
          .slice(0, 2000);
        docFields.category = deps.categorize(doc.title, sample, doc.category);
      }

      const embeddings = await embedInBatches(
        deps.embedding,
        // Embed the title as context + the chunk (stored content stays clean).
        rawChunks.map((c) => buildEmbedText(doc.title, c.content)),
        deps.signal,
      );

      const documentId = await upsertDocument(docFields);

      const chunkInputs: ChunkInput[] = rawChunks.map((c, i) => ({
        chunkIndex: c.chunkIndex,
        content: c.content,
        sectionRef: c.sectionRef,
        pageNumber: c.pageNumber,
        tokenCount: c.tokenCount,
        embedding: embeddings[i]!,
      }));

      await replaceChunks(documentId, chunkInputs);
      deps.logger.info(
        `Processed${viaOcr ? ' (OCR)' : ''}: ${doc.title} (${chunkInputs.length} chunks)`,
      );
      stats.processed++;
      if (viaOcr) stats.ocred++;
    } catch (err) {
      deps.logger.error(`Error (${doc.title}): ${(err as Error).message}`);
      stats.failed++;
    }
  }

  return stats;
}
