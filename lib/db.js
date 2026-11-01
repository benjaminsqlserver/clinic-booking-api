import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

// The Neon serverless driver talks to Postgres over WebSockets, which gives us
// real interactive transactions (BEGIN ... COMMIT) from a serverless function.
neonConfig.webSocketConstructor = ws;

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

/**
 * Run `fn(client)` with a dedicated connection. A fresh pool per invocation is
 * Neon's recommended pattern for serverless functions; it is closed afterwards.
 */
export async function withClient(fn) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

/** Run `fn(client)` inside a transaction; rolls back on any thrown error. */
export async function withTransaction(fn) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}
