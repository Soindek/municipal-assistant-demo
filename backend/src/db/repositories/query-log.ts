import type { Source } from '@municipal-assistant/shared';
import type { Pool } from 'pg';
import { getPool } from '../pool.js';

export interface QueryLogInput {
  question: string;
  /** The standalone search query actually used (after follow-up rewrite). */
  rewrittenQuery: string | null;
  answer: string;
  /** chunks.id values returned by retrieval (empty for the "I don't know" path). */
  retrievedChunkIds: string[];
  /** The sources the answer actually cited (what the user sees as "Források"). */
  sources: Source[];
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
    `INSERT INTO query_log (question, rewritten_query, answer, retrieved_chunk_ids, sources)
     VALUES ($1, $2, $3, $4::bigint[], $5::jsonb)
     RETURNING id`,
    [
      input.question,
      input.rewrittenQuery,
      input.answer,
      input.retrievedChunkIds,
      JSON.stringify(input.sources),
    ],
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
  /** The sources the answer cited. */
  sources: Source[];
  /** Distinct document titles of the retrieved (rerank-window) chunks — diagnostic. */
  retrievedDocTitles: string[];
}

/** Most recent query_log rows, newest first — for manual review / export. */
export async function listRecentQueryLog(
  limit: number,
  pool: Pool = getPool(),
): Promise<QueryLogRow[]> {
  const { rows } = await pool.query(
    `SELECT q.id, q.created_at, q.question, q.rewritten_query, q.answer,
            q.feedback, q.feedback_comment, q.sources,
            (SELECT array_agg(DISTINCT d.title ORDER BY d.title)
               FROM chunks c JOIN documents d ON d.id = c.document_id
              WHERE c.id = ANY(q.retrieved_chunk_ids)) AS retrieved_titles
       FROM query_log q
      ORDER BY q.created_at DESC
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
    sources: ((r.sources as Source[] | null) ?? []),
    retrievedDocTitles: ((r.retrieved_titles as string[] | null) ?? []),
  }));
}
