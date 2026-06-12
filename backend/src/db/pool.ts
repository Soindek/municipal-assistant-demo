import { Pool } from 'pg';
import { getEnv } from '../env.js';

let pool: Pool | null = null;

/** Megosztott connection pool. Lustán jön létre az első hívásnál. */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getEnv().DATABASE_URL });
  }
  return pool;
}

/** Pool lezárása (graceful shutdown, scriptek végén). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
