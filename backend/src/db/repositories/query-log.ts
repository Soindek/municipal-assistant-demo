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
 * Inserts a row into query_log for quality measurement (BRIEF point 6, optional)
 * and returns its id (as a string — the column is bigint). The id lets the UI
 * later attach 👍/👎 feedback to this exact answer.
 */
export async function insertQueryLog(
  input: QueryLogInput,
  pool: Pool = getPool(),
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO query_log (question, rewritten_query, answer, retrieved_chunk_ids)
     VALUES ($1, $2, $3, $4::bigint[])
     RETURNING id`,
    [input.question, input.rewrittenQuery, input.answer, input.retrievedChunkIds],
  );
  return String(rows[0]!.id);
}

/**
 * Records user feedback for a logged answer. `rating` is +1 (👍) or −1 (👎).
 * Returns false if no row with that id exists.
 */
export async function setQueryFeedback(
  id: string,
  rating: number,
  comment: string | null,
  pool: Pool = getPool(),
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE query_log
        SET feedback = $2, feedback_comment = $3, feedback_at = now()
      WHERE id = $1`,
    [id, rating, comment],
  );
  return (rowCount ?? 0) > 0;
}

export interface QueryLogRow {
  id: string;
  createdAt: Date;
  question: string;
  rewrittenQuery: string | null;
  answer: string | null;
  feedback: number | null;
  feedbackComment: string | null;
  retrievedChunkIds: string[];
}

/** Most recent query_log rows, newest first — for manual review / export. */
export async function listRecentQueryLog(
  limit: number,
  pool: Pool = getPool(),
): Promise<QueryLogRow[]> {
  const { rows } = await pool.query(
    `SELECT id, created_at, question, rewritten_query, answer,
            feedback, feedback_comment, retrieved_chunk_ids
       FROM query_log
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    createdAt: r.created_at as Date,
    question: r.question as string,
    rewrittenQuery: r.rewritten_query as string | null,
    answer: r.answer as string | null,
    feedback: r.feedback as number | null,
    feedbackComment: r.feedback_comment as string | null,
    retrievedChunkIds: ((r.retrieved_chunk_ids as string[] | null) ?? []).map(String),
  }));
}
