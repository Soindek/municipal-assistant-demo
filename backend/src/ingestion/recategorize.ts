import { fileURLToPath } from 'node:url';
import { loadTenantConfig } from '@municipal-assistant/config';
import { closePool, getPool } from '../db/pool.js';
import { getEnv } from '../env.js';
import { consoleLogger } from '../logger.js';
import { buildCategorizer } from './categorize.js';

/**
 * Re-categorizes documents already in the DB using their (OCR'd) text — no
 * re-fetch, no re-embed. Run after improving the category keywords, or after an
 * OCR pass made previously scanned documents readable.
 */
export async function recategorize(): Promise<void> {
  const env = getEnv();
  const config = loadTenantConfig(env.TENANT_ID);
  const categorize = buildCategorizer(config);
  const pool = getPool();

  const { rows } = await pool.query<{
    id: string;
    title: string;
    category: string;
    sample: string;
  }>(
    `SELECT d.id::text AS id, d.title, d.category,
            (SELECT COALESCE(string_agg(content, E'\n'), '')
             FROM (SELECT content FROM chunks WHERE document_id = d.id
                   ORDER BY chunk_index LIMIT 3) s) AS sample
       FROM documents d`,
  );

  // Deterministic fallback (the first configured category) so re-runs don't
  // depend on the document's current — possibly already-changed — category.
  const fallback = Object.keys(config.categories)[0] ?? 'rendeletek';

  let changed = 0;
  const distribution: Record<string, number> = {};
  for (const row of rows) {
    const next = categorize(row.title, row.sample.slice(0, 2000), fallback);
    distribution[next] = (distribution[next] ?? 0) + 1;
    if (next !== row.category) {
      await pool.query('UPDATE documents SET category = $1 WHERE id = $2', [next, row.id]);
      changed++;
    }
  }

  consoleLogger.info(`Recategorized ${changed}/${rows.length} documents.`);
  consoleLogger.info(`New category distribution: ${JSON.stringify(distribution)}`);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  recategorize()
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
