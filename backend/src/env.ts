import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { repoRoot } from './paths.js';

// The .env is always at the repo root, regardless of which workspace
// the process is started from.
loadDotenv({ path: resolve(repoRoot, '.env') });

const EnvSchema = z.object({
  /** The only required secret — used by both the LLM and embedding. */
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is missing (see .env.example)'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is missing (see .env.example)'),
  PORT: z.coerce.number().int().positive().default(3001),
  TENANT_ID: z.string().min(1).default('vacratot'),
  UPLOADS_DIR: z.string().min(1).default('./data/uploads'),
  /** Simple bearer-token protection for /api/reindex (optional). */
  REINDEX_TOKEN: z.string().optional(),

  /** OCR scanned PDFs during ingestion. Slow; set to 'false' for fast runs. */
  OCR_ENABLED: z
    .string()
    .default('true')
    .transform((v) => !['false', '0', 'no', 'off'].includes(v.toLowerCase())),
  /** Safety cap on pages OCR'd per document (0 = no cap). */
  OCR_MAX_PAGES: z.coerce.number().int().min(0).default(15),
  /** Render scale before OCR; higher = better accuracy but slower. */
  OCR_VIEWPORT_SCALE: z.coerce.number().positive().default(3),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Validated environment variables. Throws a descriptive error on invalid/missing values. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** The UPLOADS_DIR as an absolute path, relative to the repo root. */
export function resolveUploadsDir(): string {
  return resolve(repoRoot, getEnv().UPLOADS_DIR);
}
