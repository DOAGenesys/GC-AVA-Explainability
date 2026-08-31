import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// @ts-expect-error - plain JS helper shared with the init-db script, no types needed
import { splitSqlStatements } from '../scripts/split-sql.mjs';

const REQUIRED_TABLES = [
  'ava_flows',
  'ava_sessions',
  'ava_turns',
  'ava_executions',
  'ava_tool_calls',
  'ingest_runs',
];

async function schemaStatements(): Promise<string[]> {
  const sql = await readFile(new URL('../src/server/db/schema.sql', import.meta.url), 'utf8');
  return splitSqlStatements(sql);
}

describe('splitSqlStatements', () => {
  it('keeps a statement that is introduced by a comment block', () => {
    const statements = splitSqlStatements(
      ['-- explains the table below', 'CREATE TABLE a (id INT);', 'CREATE INDEX i ON a (id);'].join(
        '\n',
      ),
    );
    expect(statements).toEqual(['CREATE TABLE a (id INT)', 'CREATE INDEX i ON a (id)']);
  });

  it('strips comments nested inside a statement body', () => {
    const statements = splitSqlStatements(
      ['CREATE TABLE a (', '  id INT,', '  -- why this column exists', '  name TEXT', ');'].join(
        '\n',
      ),
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain('--');
    expect(statements[0]).toContain('name TEXT');
  });

  it('never emits a comment-only or empty statement', () => {
    const statements = splitSqlStatements('-- just a comment\n\n\n-- another\n');
    expect(statements).toEqual([]);
  });

  it('keeps multi-line statements intact rather than splitting mid-body', async () => {
    for (const statement of await schemaStatements()) {
      // A balanced paren count proves no CREATE was cut in half by the separator regex.
      const open = (statement.match(/\(/g) ?? []).length;
      const close = (statement.match(/\)/g) ?? []).length;
      expect(open, `unbalanced parens in: ${statement.slice(0, 60)}`).toBe(close);
    }
  });

  it('creates every table the read paths require', async () => {
    const statements = await schemaStatements();
    for (const table of REQUIRED_TABLES) {
      const created = statements.some((s) =>
        new RegExp(`^CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(s),
      );
      expect(created, `schema.sql never creates ${table}`).toBe(true);
    }
  });

  it('orders each table ahead of the indexes that reference it', async () => {
    const statements = await schemaStatements();
    for (const table of REQUIRED_TABLES) {
      const createdAt = statements.findIndex((s) =>
        new RegExp(`^CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(s),
      );
      const firstIndexAt = statements.findIndex((s) =>
        new RegExp(`^CREATE INDEX .* ON ${table}\\b`, 'i').test(s),
      );
      if (firstIndexAt !== -1) expect(createdAt).toBeLessThan(firstIndexAt);
    }
  });
});
