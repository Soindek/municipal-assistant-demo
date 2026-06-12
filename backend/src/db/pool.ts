import { Pool } from 'pg';
import { getEnv } from '../env.js';

let pool: Pool | null = null;

/** Shared connection pool. Lazily created on first call. */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getEnv().DATABASE_URL });
  }
  return pool;
}

/** Close the pool (graceful shutdown, at the end of scripts). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
