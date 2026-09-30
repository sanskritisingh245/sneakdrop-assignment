import pg, { type PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://localhost/sneakdrop',
});

export async function init(): Promise<void> {
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
}

export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
