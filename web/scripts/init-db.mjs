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
import { createRequire } from 'node:module';

import { splitSqlStatements } from './split-sql.mjs';

const require = createRequire(import.meta.url);
const { createClient, createPool } = require('@vercel/postgres');

// An explicit POSTGRES_URL always wins, so the same script can target a deployed database without
// having to keep its connection string in a local file.
if (!process.env.POSTGRES_URL) {
  try {
    process.loadEnvFile(new URL('../.env.local', import.meta.url));
  } catch {
    // No .env.local: fall through to the check below, which explains both options.
  }
}

if (!process.env.POSTGRES_URL) {
  console.error(
    'POSTGRES_URL is not set. Add it to .env.local, or pass it inline to target a deployed database.',
  );
  process.exit(1);
}

const schema = await readFile(new URL('../src/server/db/schema.sql', import.meta.url), 'utf8');
const statements = splitSqlStatements(schema);

const connectionString = process.env.POSTGRES_URL;

/*
 * @vercel/postgres validates the connection string against the constructor: createClient() only
 * accepts a direct string (and only ever reads POSTGRES_URL_NON_POOLING from the environment),
 * while createPool() only accepts a pooled one. A Neon dashboard hands out the pooled string, so
 * pass it explicitly and pick the matching constructor rather than letting either default.
 */
const isPooled = connectionString.includes('-pooler.');
const db = isPooled ? createPool({ connectionString }) : createClient({ connectionString });

// A pool connects lazily; a client has to be opened first.
if (!isPooled) await db.connect();

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
