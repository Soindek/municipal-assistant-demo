import { fileURLToPath } from 'node:url';
import { loadTenantConfig } from '@municipal-assistant/config';
import { getEnv } from '../env.js';
import { closePool } from '../db/pool.js';
import { createLlmClients } from '../llm/index.js';
import { consoleLogger } from '../logger.js';
import { buildCategorizer } from './categorize.js';
import { ocrPdf, terminateOcr } from './ocr.js';
import { ingestSource, type IngestStats } from './pipeline.js';
import { createSource } from './registry.js';

/** Optional `--source=<adapter>` filter (the `seed` script relies on this). */
function parseSourceFilter(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--source='));
  return arg ? arg.slice('--source='.length) : null;
}

export async function run(): Promise<IngestStats> {
  const env = getEnv();
  const config = loadTenantConfig(env.TENANT_ID);
  const { embedding } = createLlmClients(config);

  const filter = parseSourceFilter();
  const descriptors = config.sources.filter((s) => !filter || s.adapter === filter);

  const totals: IngestStats = { processed: 0, ocred: 0, skipped: 0, scanned: 0, failed: 0 };
  if (descriptors.length === 0) {
    consoleLogger.warn(
      `No sources to process (tenant=${config.tenantId}, filter=${filter ?? 'none'}).`,
    );
    return totals;
  }

  // OCR hook (env-gated): scanned PDFs are OCR'd when enabled, else marked needs_ocr.
  const ocr = env.OCR_ENABLED
    ? (bytes: Uint8Array) =>
        ocrPdf(bytes, { viewportScale: env.OCR_VIEWPORT_SCALE, maxPages: env.OCR_MAX_PAGES })
    : undefined;
  consoleLogger.info(`OCR ${env.OCR_ENABLED ? 'enabled' : 'disabled'} for scanned PDFs.`);

  // Content-based category refinement from the (extracted/OCR'd) text.
  const categorize = buildCategorizer(config);

  try {
    for (const descriptor of descriptors) {
      const source = createSource(descriptor);
      consoleLogger.info(`Source starting: ${source.name}`);
      const stats = await ingestSource(source, {
        tenantId: config.tenantId,
        embedding,
        logger: consoleLogger,
        ocr,
        categorize,
      });
      consoleLogger.info(`Source done: ${source.name} → ${JSON.stringify(stats)}`);
      totals.processed += stats.processed;
      totals.ocred += stats.ocred;
      totals.skipped += stats.skipped;
      totals.scanned += stats.scanned;
      totals.failed += stats.failed;
    }
  } finally {
    await terminateOcr();
  }

  consoleLogger.info(`Total: ${JSON.stringify(totals)}`);
  return totals;
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  run()
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
