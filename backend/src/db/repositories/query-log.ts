import type { Pool } from 'pg';
import { getPool } from '../pool.js';

export interface QueryLogInput {
  question: string;
  /** The standalone search query actually used (after follow-up rewrite). */
  rewrittenQuery: string | null;
  answer: string;
  /** chunks.id values returned by retrieval (empty for the "I don't know" path). */
  retrievedChunkIds: string[];
}

/**
 * Inserts a row into query_log for quality measurement (BRIEF point 6, optional).
 * The string ids are cast to bigint[] in the query.
 */
export async function insertQueryLog(input: QueryLogInput, pool: Pool = getPool()): Promise<void> {
  await pool.query(
    `INSERT INTO query_log (question, rewritten_query, answer, retrieved_chunk_ids)
     VALUES ($1, $2, $3, $4::bigint[])`,
    [input.question, input.rewrittenQuery, input.answer, input.retrievedChunkIds],
  );
}
