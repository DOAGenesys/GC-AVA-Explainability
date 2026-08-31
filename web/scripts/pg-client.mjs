/**
 * Shared Postgres connection handling for the maintenance scripts.
 *
 * @vercel/postgres validates the connection string against the constructor: createClient() only
 * accepts a direct string (and only reads POSTGRES_URL_NON_POOLING from the environment), while
 * createPool() only accepts a pooled one. A Neon dashboard hands out the pooled string, so the
 * string is passed explicitly and the constructor chosen to match it.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createClient, createPool } = require('@vercel/postgres');

/**
 * Resolve POSTGRES_URL, falling back to .env.local so the same script works locally and against a
 * deployed database. An explicit environment value always wins.
 *
 * @returns {string | null}
 */
export function loadPostgresUrl() {
  if (!process.env.POSTGRES_URL) {
    try {
      process.loadEnvFile(new URL('../.env.local', import.meta.url));
    } catch {
      // No .env.local; the caller reports the missing variable.
    }
  }
  return process.env.POSTGRES_URL ?? null;
}

/**
 * Open a connection, choosing the constructor that matches the string.
 *
 * @param {string} connectionString
 * @returns {Promise<{ db: any, isPooled: boolean }>}
 */
export async function openDb(connectionString) {
  const isPooled = connectionString.includes('-pooler.');
  const db = isPooled ? createPool({ connectionString }) : createClient({ connectionString });
  // A pool connects lazily; a client has to be opened first.
  if (!isPooled) await db.connect();
  return { db, isPooled };
}
