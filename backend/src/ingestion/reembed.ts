import { fileURLToPath } from 'node:url';
import { loadTenantConfig } from '@municipal-assistant/config';
import { closePool, getPool } from '../db/pool.js';
import { getEnv } from '../env.js';
import { createLlmClients } from '../llm/index.js';
import { consoleLogger } from '../logger.js';
import { buildEmbedText } from './embed-text.js';

/**
 * Re-embeds all chunks in place using the current embedding text (document
 * title as context + chunk). No re-fetch/OCR. Run after changing how the
 * embedding text is built. Idempotent: stored content is never modified.
 */
export async function reembed(): Promise<void> {
  const env = getEnv();
  const config = loadTenantConfig(env.TENANT_ID);
  const { embedding } = createLlmClients(config);
  const pool = getPool();

  const { rows } = await pool.query<{ id: string; title: string; content: string }>(
    `SELECT c.id::text AS id, d.title, c.content
       FROM chunks c JOIN documents d ON d.id = c.document_id
      ORDER BY c.id`,
  );
  consoleLogger.info(`Re-embedding ${rows.length} chunks...`);

  const batchSize = 96;
  let done = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const vecs = await embedding.embed(batch.map((r) => buildEmbedText(r.title, r.content)));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let j = 0; j < batch.length; j++) {
        await client.query('UPDATE chunks SET embedding = $1::vector WHERE id = $2', [
          `[${vecs[j]!.join(',')}]`,
          batch[j]!.id,
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    done += batch.length;
    consoleLogger.info(`  ${done}/${rows.length}`);
  }
  consoleLogger.info('Re-embedding complete.');
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  reembed()
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
