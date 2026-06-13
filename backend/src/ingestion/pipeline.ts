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
import { extractText, type PageText } from './extract.js';

export interface IngestStats {
  processed: number;
  /** Of `processed`, how many were recovered via OCR. */
  ocred: number;
  skipped: number;
  scanned: number;
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
  const stats: IngestStats = { processed: 0, ocred: 0, skipped: 0, scanned: 0, failed: 0 };
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
        if (!deps.ocr) {
          // No OCR available: mark needs_ocr (no chunks) so the corpus stays clean
          // but the doc is tracked and re-indexable once OCR is enabled.
          const documentId = await upsertDocument({ ...docFields, status: 'needs_ocr' });
          await deleteChunksForDocument(documentId);
          deps.logger.warn(`Scanned, no extractable text — marked needs_ocr: ${doc.title}`);
          stats.scanned++;
          continue;
        }
        deps.logger.info(`Scanned — running OCR: ${doc.title}`);
        pages = await deps.ocr(fetched.bytes);
        viaOcr = true;
      }

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

      const embeddings = await embedInBatches(
        deps.embedding,
        rawChunks.map((c) => c.content),
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
