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
  /** Reciprocal Rank Fusion score (relevance only). */
  rrf: number;
  /** RRF after the recency boost — the ordering follows this. */
  score: number;
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Hungarian interrogatives / generic question words. `websearch_to_tsquery`
 * ANDs every term, so leaving these in excludes fact-stating documents that
 * never repeat the question word (e.g. a fee list answering "mennyi…?" doesn't
 * contain "mennyi"). The 'hungarian' ts config already drops ordinary stopwords;
 * this only removes the question framing so the content words drive the match.
 */
const LEXICAL_NOISE = new Set([
  'mennyi', 'mennyibe', 'mennyit', 'hány', 'hányféle', 'hogyan', 'hogy', 'mikor', 'mettől',
  'meddig', 'hol', 'hova', 'honnan', 'ki', 'kik', 'kit', 'mi', 'mit', 'mik', 'milyen', 'miért',
  'melyik', 'mely', 'kell', 'lehet', 'van', 'vannak', 'szükséges', 'szeretném', 'szeretnék',
]);

/** Builds the full-text query text: strips question framing, keeps content words. */
function toLexicalQuery(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[?!.,;:()"']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !LEXICAL_NOISE.has(w))
    .join(' ')
    .trim();
  return cleaned || text; // if everything was stripped, fall back to the original
}

// RRF constant (the value commonly used in the literature).
const RRF_K = 60;

// Recency boost (BRIEF point 8: prefer fresher documents). Relevance stays
// primary; a fresher doc gets a gentle multiplicative lift, capped by the weight.
// A document at the half-life age keeps half of its recency factor; missing
// published_at gets no boost (treated as oldest).
const RECENCY_WEIGHT = 0.4;
const RECENCY_HALFLIFE_DAYS = 365;

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
  categoryWeights: Record<string, number> = {},
  pool: Pool = getPool(),
): Promise<RetrievedChunk[]> {
  const vec = toVectorLiteral(queryEmbedding);
  const lexicalQuery = toLexicalQuery(queryText);
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
    score: number;
  }>(
    `
    WITH semantic AS (
      SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> $1::vector) AS rank
      FROM chunks c
      WHERE c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $1::vector
      LIMIT $3
    ),
    -- ts_rank with length normalization (flag 1: divide by 1+log(length)) so a
    -- verbose document repeating a term doesn't outrank a concise authoritative one.
    lexical AS (
      SELECT c.id, row_number() OVER (ORDER BY ts_rank(c.tsv, q.query, 1) DESC) AS rank
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
      f.rrf                                        AS rrf,
      f.rrf
        * (1 + $6 * CASE
            WHEN d.published_at IS NULL THEN 0
            ELSE EXP(-LN(2) * GREATEST(0, EXTRACT(EPOCH FROM (now() - d.published_at)) / 86400.0) / $7)
          END)
        * COALESCE(($8::jsonb ->> d.category)::float, 1.0)  AS score
    FROM fused f
    JOIN chunks c ON c.id = f.id
    JOIN documents d ON d.id = c.document_id
    WHERE d.status = 'active'
    ORDER BY score DESC
    LIMIT $5
    `,
    [
      vec,
      lexicalQuery,
      perList,
      RRF_K,
      topK,
      RECENCY_WEIGHT,
      RECENCY_HALFLIFE_DAYS,
      JSON.stringify(categoryWeights),
    ],
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
    score: Number(r.score),
  }));
}

interface ShortlistRow {
  id: string;
  content: string;
  section_ref: string | null;
  page_number: number | null;
  title: string;
  category: string;
  source_url: string;
  published_at: Date | null;
  similarity: number;
}

const toChunk = (r: ShortlistRow): RetrievedChunk => ({
  chunkId: r.id,
  content: r.content,
  sectionRef: r.section_ref,
  pageNumber: r.page_number,
  documentTitle: r.title,
  category: r.category,
  sourceUrl: r.source_url,
  publishedAt: r.published_at,
  similarity: Number(r.similarity),
  rrf: 0,
  score: Number(r.similarity),
});

const SHORTLIST_COLUMNS = `
  c.id::text AS id, c.content, c.section_ref, c.page_number,
  d.title, d.category, d.source_url, d.published_at,
  (1 - (c.embedding <=> $1::vector)) AS similarity`;

/**
 * Guarantees that the best AUTHORITATIVE documents reach the rerank window. In
 * the global pool a concise in-force decree is crowded out by the large archival
 * corpus and cut before the rerank can see it. Two arms, both restricted to the
 * authoritative categories:
 *  - filtered semantic KNN — with a raised hnsw.ef_search, because the HNSW index
 *    returns its nearest GLOBALLY and the category filter is applied afterwards;
 *    with the default ef_search the filter starves (often 0 rows survive);
 *  - title match — documents whose TITLE is about the topic (the decree titled
 *    "…kommunális adójáról"). Only a REAL websearch match is included; an empty
 *    keyphrase or no match contributes nothing (no forced authoritative results).
 * This only guarantees INCLUSION; the rerank decides the final order.
 */
export async function authoritativeShortlist(
  queryEmbedding: number[],
  keyphrase: string,
  categories: string[],
  k: number,
  pool: Pool = getPool(),
): Promise<RetrievedChunk[]> {
  if (categories.length === 0) return [];
  const vec = toVectorLiteral(queryEmbedding);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The category filter is applied after the HNSW scan, so raise ef_search to
    // keep enough candidates for the (small) authoritative subset.
    await client.query('SET LOCAL hnsw.ef_search = 1000');

    const knn = await client.query<ShortlistRow>(
      `SELECT ${SHORTLIST_COLUMNS}
       FROM chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.embedding IS NOT NULL AND d.status = 'active' AND d.category = ANY($2::text[])
       ORDER BY c.embedding <=> $1::vector
       LIMIT $3`,
      [vec, categories, k],
    );

    let titleRows: ShortlistRow[] = [];
    if (keyphrase.trim()) {
      const title = await client.query<ShortlistRow>(
        `SELECT ${SHORTLIST_COLUMNS}
         FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE d.status = 'active' AND d.category = ANY($2::text[])
           AND to_tsvector('hungarian', d.title) @@ websearch_to_tsquery('hungarian', $3)
         ORDER BY c.embedding <=> $1::vector
         LIMIT $4`,
        [vec, categories, keyphrase, k],
      );
      titleRows = title.rows;
    }
    await client.query('COMMIT');

    // Title matches first (strongest authoritative signal), then KNN; dedup by chunk.
    const seen = new Set<string>();
    const out: RetrievedChunk[] = [];
    for (const r of [...titleRows, ...knn.rows]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(toChunk(r));
    }
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
