import type {
  DocumentSource,
  DocumentSourceContext,
  SourceLogger,
} from '@municipal-assistant/shared';
import type { EmbeddingClient } from '../llm/types.js';
import { findByExternalId, upsertDocument } from '../db/repositories/documents.js';
import { replaceChunks, type ChunkInput } from '../db/repositories/chunks.js';
import { chunkPages } from './chunk.js';
import { extractText } from './extract.js';

export interface IngestStats {
  processed: number;
  skipped: number;
  scanned: number;
  failed: number;
}

export interface PipelineDeps {
  tenantId: string;
  embedding: EmbeddingClient;
  logger: SourceLogger;
  signal?: AbortSignal;
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
 *   list → (skip based on change token) → fetch → extract(+OCR TODO) →
 *   §-aware chunking → embedding → upsert.
 *
 * It knows nothing about the source beyond what the DocumentSource interface
 * provides (BRIEF points 3/4).
 */
export async function ingestSource(
  source: DocumentSource,
  deps: PipelineDeps,
): Promise<IngestStats> {
  const stats: IngestStats = { processed: 0, skipped: 0, scanned: 0, failed: 0 };
  const ctx: DocumentSourceContext = {
    tenantId: deps.tenantId,
    logger: deps.logger,
    signal: deps.signal,
  };

  for await (const doc of source.list(ctx)) {
    try {
      // Change detection: if there is a token and it matches the stored one, skip.
      const existing = await findByExternalId(source.name, doc.externalId);
      if (existing && doc.changeToken !== null && existing.changeToken === doc.changeToken) {
        deps.logger.info(`Skipped (unchanged): ${doc.title}`);
        stats.skipped++;
        continue;
      }

      const fetched = await source.fetch(doc, ctx);
      const extracted = await extractText(fetched);

      if (extracted.likelyScanned) {
        // Integration point for the OCR fallback (see TODO in extract.ts).
        deps.logger.warn(`Appears scanned, OCR needed (TODO) — skipped: ${doc.title}`);
        stats.scanned++;
        continue;
      }

      const rawChunks = chunkPages(extracted.pages);
      if (rawChunks.length === 0) {
        deps.logger.warn(`No extractable chunk — skipped: ${doc.title}`);
        stats.skipped++;
        continue;
      }

      const embeddings = await embedInBatches(
        deps.embedding,
        rawChunks.map((c) => c.content),
        deps.signal,
      );

      const documentId = await upsertDocument({
        sourceName: source.name,
        externalId: doc.externalId,
        title: doc.title,
        category: doc.category,
        sourceUrl: doc.sourceUrl,
        mimeType: doc.mimeType,
        changeToken: doc.changeToken,
        publishedAt: doc.publishedAt ?? null,
      });

      const chunkInputs: ChunkInput[] = rawChunks.map((c, i) => ({
        chunkIndex: c.chunkIndex,
        content: c.content,
        sectionRef: c.sectionRef,
        pageNumber: c.pageNumber,
        tokenCount: c.tokenCount,
        embedding: embeddings[i]!,
      }));

      await replaceChunks(documentId, chunkInputs);
      deps.logger.info(`Processed: ${doc.title} (${chunkInputs.length} chunks)`);
      stats.processed++;
    } catch (err) {
      deps.logger.error(`Error (${doc.title}): ${(err as Error).message}`);
      stats.failed++;
    }
  }

  return stats;
}
