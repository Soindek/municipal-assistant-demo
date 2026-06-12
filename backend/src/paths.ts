import { fileURLToPath } from 'node:url';

/** The monorepo root (two levels up from backend/src/). */
export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
