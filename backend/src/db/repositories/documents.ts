import type { Pool } from 'pg';
import { getPool } from '../pool.js';

/** A változásfigyeléshez szükséges minimális dokumentum-állapot. */
export interface ExistingDocument {
  id: string;
  changeToken: string | null;
  status: string;
}

export interface UpsertDocumentInput {
  sourceName: string;
  externalId: string;
  title: string;
  category: string;
  sourceUrl: string;
  mimeType: string | null;
  changeToken: string | null;
  publishedAt: Date | null;
}

/** Megkeresi egy adapteren belül stabil külső kulcs alapján a dokumentumot. */
export async function findByExternalId(
  sourceName: string,
  externalId: string,
  pool: Pool = getPool(),
): Promise<ExistingDocument | null> {
  const { rows } = await pool.query<ExistingDocument>(
    `SELECT id::text, change_token AS "changeToken", status
       FROM documents
      WHERE source_name = $1 AND external_id = $2`,
    [sourceName, externalId],
  );
  return rows[0] ?? null;
}

/** Beszúrja vagy frissíti a dokumentum metaadatait; visszaadja az id-t. */
export async function upsertDocument(
  input: UpsertDocumentInput,
  pool: Pool = getPool(),
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO documents
       (source_name, external_id, title, category, source_url, mime_type, change_token, published_at, status, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', now())
     ON CONFLICT (source_name, external_id) DO UPDATE SET
       title        = EXCLUDED.title,
       category     = EXCLUDED.category,
       source_url   = EXCLUDED.source_url,
       mime_type    = EXCLUDED.mime_type,
       change_token = EXCLUDED.change_token,
       published_at = EXCLUDED.published_at,
       status       = 'active',
       fetched_at   = now()
     RETURNING id::text`,
    [
      input.sourceName,
      input.externalId,
      input.title,
      input.category,
      input.sourceUrl,
      input.mimeType,
      input.changeToken,
      input.publishedAt,
    ],
  );
  return rows[0]!.id;
}
