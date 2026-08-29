/**
 * Apply schema.sql to the configured Postgres database.
 *
 * Statements are idempotent (CREATE TABLE IF NOT EXISTS), so this is safe to re-run after a schema
 * change that only adds objects. Anything that alters an existing column still needs a real
 * migration.
 *
 * Run with:  npm run db:init
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createClient } = require('@vercel/postgres');

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is not set. Add it to .env.local or pull it with `vercel env pull`.');
  process.exit(1);
}

const schema = await readFile(new URL('../src/server/db/schema.sql', import.meta.url), 'utf8');

// Split on semicolons at end of line so the multi-line CREATE statements stay intact.
const statements = schema
  .split(/;\s*$/m)
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.startsWith('--'));

const client = createClient();
await client.connect();

let applied = 0;
try {
  for (const statement of statements) {
    await client.query(statement);
    applied += 1;
  }
  console.log(`Applied ${applied} statements.`);
} catch (err) {
  console.error(`Failed on statement ${applied + 1}:`, err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
