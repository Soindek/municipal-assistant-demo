import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './paths.js';

let cached: string | null = null;

/**
 * The product version — single source of truth is the root package.json `version`
 * (semver). Surfaced in /api/config (UI footer) and /api/health (deploy check).
 */
export function appVersion(): string {
  if (cached !== null) return cached;
  try {
    const raw = readFileSync(join(repoRoot, 'package.json'), 'utf8');
    cached = String((JSON.parse(raw) as { version?: string }).version ?? '0.0.0');
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
