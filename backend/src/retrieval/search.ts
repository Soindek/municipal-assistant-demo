import type { Pool } from 'pg';
import { getPool } from '../db/pool.js';

export interface RetrievedChunk {
  chunkId: string;
  content: string;
  sectionRef: string | null;
  pageNumber: number | null;
  documentTitle: string;
  category: string;
  sourceUrl: string;
  publishedAt: Date | null;
  /** Cosine similarity (0..1) — this is what the minScore threshold checks. */
  similarity: number;
  /** Reciprocal Rank Fusion score — the ordering follows this. */
  rrf: number;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

// RRF constant (the value commonly used in the literature).
const RRF_K = 60;

/**
 * Hybrid search: semantic (pgvector HNSW cosine) + Hungarian full-text
 * (GIN), combined with Reciprocal Rank Fusion (BRIEF point 6).
 *
 * The `similarity` field is the best semantic cosine similarity for the given
 * chunk — the caller relies on this for the minScore threshold.
 */
export async function hybridSearch(
  queryEmbedding: number[],
  queryText: string,
  topK: number,
  pool: Pool = getPool(),
): Promise<RetrievedChunk[]> {
  const vec = toVectorLiteral(queryEmbedding);
  const perList = Math.max(topK * 4, 20);

  const { rows } = await pool.query<{
    id: string;
    content: string;
    section_ref: string | null;
    page_number: number | null;
    title: string;
    category: string;
    source_url: string;
    published_at: Date | null;
    similarity: number;
    rrf: number;
  }>(
    `
    WITH semantic AS (
      SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> $1::vector) AS rank
      FROM chunks c
      WHERE c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $1::vector
      LIMIT $3
    ),
    lexical AS (
      SELECT c.id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q.query) DESC) AS rank
      FROM chunks c, websearch_to_tsquery('hungarian', $2) AS q(query)
      WHERE c.tsv @@ q.query
      LIMIT $3
    ),
    fused AS (
      SELECT id, SUM(1.0 / ($4 + rank)) AS rrf
      FROM (
        SELECT id, rank FROM semantic
        UNION ALL
        SELECT id, rank FROM lexical
      ) u
      GROUP BY id
    )
    SELECT
      c.id::text                                   AS id,
      c.content                                    AS content,
      c.section_ref                                AS section_ref,
      c.page_number                                AS page_number,
      d.title                                      AS title,
      d.category                                   AS category,
      d.source_url                                 AS source_url,
      d.published_at                               AS published_at,
      (1 - (c.embedding <=> $1::vector))           AS similarity,
      f.rrf                                        AS rrf
    FROM fused f
    JOIN chunks c ON c.id = f.id
    JOIN documents d ON d.id = c.document_id
    WHERE d.status = 'active'
    ORDER BY f.rrf DESC
    LIMIT $5
    `,
    [vec, queryText, perList, RRF_K, topK],
  );

  return rows.map((r) => ({
    chunkId: r.id,
    content: r.content,
    sectionRef: r.section_ref,
    pageNumber: r.page_number,
    documentTitle: r.title,
    category: r.category,
    sourceUrl: r.source_url,
    publishedAt: r.published_at,
    similarity: Number(r.similarity),
    rrf: Number(r.rrf),
  }));
}
