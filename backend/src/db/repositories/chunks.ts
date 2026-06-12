import type { Pool, PoolClient } from 'pg';
import { getPool } from '../pool.js';

export interface ChunkInput {
  chunkIndex: number;
  content: string;
  sectionRef: string | null;
  pageNumber: number | null;
  tokenCount: number | null;
  /** Output of the embedding model (text-embedding-3-small → 1536 dim). */
  embedding: number[];
}

/** pgvector literal: [a,b,c]. The ::vector cast happens in the query. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/** Deletes all chunks belonging to a document (before reprocessing). */
export async function deleteChunksForDocument(
  documentId: string,
  executor: Pool | PoolClient = getPool(),
): Promise<void> {
  await executor.query('DELETE FROM chunks WHERE document_id = $1', [documentId]);
}

/** Inserts chunks. The full replacement (delete + insert) runs in a transaction. */
export async function replaceChunks(
  documentId: string,
  chunks: ChunkInput[],
  pool: Pool = getPool(),
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await deleteChunksForDocument(documentId, client);
    for (const c of chunks) {
      await client.query(
        `INSERT INTO chunks
           (document_id, chunk_index, content, section_ref, page_number, token_count, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
        [
          documentId,
          c.chunkIndex,
          c.content,
          c.sectionRef,
          c.pageNumber,
          c.tokenCount,
          toVectorLiteral(c.embedding),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
