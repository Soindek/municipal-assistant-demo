import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { repoRoot } from './paths.js';

// A .env mindig a repo gyökerében van, függetlenül attól, melyik workspace-ből
// indítjuk a folyamatot.
loadDotenv({ path: resolve(repoRoot, '.env') });

const EnvSchema = z.object({
  /** Az egyetlen kötelező titok — LLM és embedding is ezt használja. */
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY hiányzik (lásd .env.example)'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL hiányzik (lásd .env.example)'),
  PORT: z.coerce.number().int().positive().default(3001),
  TENANT_ID: z.string().min(1).default('vacratot'),
  UPLOADS_DIR: z.string().min(1).default('./data/uploads'),
  /** A /api/reindex egyszerű bearer-token védelme (opcionális). */
  REINDEX_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Validált környezeti változók. Hibás/hiányzó érték esetén beszédes hibát dob. */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Hibás környezeti konfiguráció:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Az UPLOADS_DIR abszolút útként, a repo gyökeréhez viszonyítva. */
export function resolveUploadsDir(): string {
  return resolve(repoRoot, getEnv().UPLOADS_DIR);
}
