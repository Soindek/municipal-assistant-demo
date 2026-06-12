import { fileURLToPath } from 'node:url';

/** A monorepo gyökere (a backend/src/ -ből két szinttel feljebb). */
export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
