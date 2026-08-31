/**
 * Apply schema.sql to the configured Postgres database.
 *
 * Statements are idempotent (CREATE TABLE IF NOT EXISTS), so this is safe to re-run after a schema
 * change that only adds objects. Anything that alters an existing column still needs a real
 * migration.
 *
 * Run with:  npm run db:init
 *
 * Against a local database, POSTGRES_URL is read from .env.local. Against a deployed database, pass
 * it in the environment instead - the schema has to be applied once per database, and a fresh
 * deployment's database is empty until it is:
 *
 *   POSTGRES_URL="postgres://..." npm run db:init          # bash/zsh
 *   $env:POSTGRES_URL="postgres://..."; npm run db:init    # PowerShell
 */

import { readFile } from 'node:fs/promises';

import { loadPostgresUrl, openDb } from './pg-client.mjs';
import { splitSqlStatements } from './split-sql.mjs';

const connectionString = loadPostgresUrl();
if (!connectionString) {
  console.error(
    'POSTGRES_URL is not set. Add it to .env.local, or pass it inline to target a deployed database.',
  );
  process.exit(1);
}

const schema = await readFile(new URL('../src/server/db/schema.sql', import.meta.url), 'utf8');
const statements = splitSqlStatements(schema);

const { db, isPooled } = await openDb(connectionString);

let applied = 0;
try {
  for (const statement of statements) {
    await db.query(statement);
    applied += 1;
  }
  console.log(`Applied ${applied} statements to ${isPooled ? 'pooled' : 'direct'} connection.`);
} catch (err) {
  console.error(`Failed on statement ${applied + 1}:`, err.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
