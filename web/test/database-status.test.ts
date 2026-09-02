import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The db module is server-only and talks to @vercel/postgres, so the driver is replaced with a
// controllable stub. Only the classification of the probe result is under test here.
const sql = vi.fn();
vi.mock('@vercel/postgres', () => ({ sql: (...args: unknown[]) => sql(...args) }));
vi.mock('server-only', () => ({}));

const ALL_TABLES = ['ava_flows', 'ava_sessions', 'ava_executions', 'ava_tool_calls', 'ingest_runs'];

/** Shape a to_regclass probe row where `present` tables resolve and the rest come back NULL. */
function probeRow(present: string[]): Record<string, string | null> {
  return Object.fromEntries(ALL_TABLES.map((t) => [t, present.includes(t) ? `public.${t}` : null]));
}

async function getDatabaseStatus() {
  const mod = await import('@/server/db');
  return mod.getDatabaseStatus();
}

describe('getDatabaseStatus', () => {
  const original = process.env.POSTGRES_URL;

  beforeEach(() => {
    vi.resetModules();
    sql.mockReset();
    process.env.POSTGRES_URL = 'postgres://user:pw@localhost:5432/db';
  });

  afterEach(() => {
    if (original === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = original;
  });

  it('reports not-configured without touching the database', async () => {
    delete process.env.POSTGRES_URL;
    await expect(getDatabaseStatus()).resolves.toEqual({ state: 'not-configured' });
    expect(sql).not.toHaveBeenCalled();
  });

  it('reports ready when every required table resolves', async () => {
    sql.mockResolvedValue({ rows: [probeRow(ALL_TABLES)] });
    await expect(getDatabaseStatus()).resolves.toEqual({ state: 'ready' });
  });

  it('lists the missing tables when the schema was never applied', async () => {
    sql.mockResolvedValue({ rows: [probeRow([])] });
    await expect(getDatabaseStatus()).resolves.toEqual({
      state: 'schema-missing',
      missingTables: ALL_TABLES,
    });
  });

  it('treats a partially applied schema as missing rather than ready', async () => {
    sql.mockResolvedValue({ rows: [probeRow(['ava_flows', 'ava_sessions'])] });
    await expect(getDatabaseStatus()).resolves.toEqual({
      state: 'schema-missing',
      missingTables: ['ava_executions', 'ava_tool_calls', 'ingest_runs'],
    });
  });

  it('reports unreachable instead of throwing when the connection fails', async () => {
    sql.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(getDatabaseStatus()).resolves.toEqual({ state: 'unreachable' });
  });

  it('does not report ready when the probe comes back with no rows', async () => {
    sql.mockResolvedValue({ rows: [] });
    await expect(getDatabaseStatus()).resolves.toEqual({
      state: 'schema-missing',
      missingTables: ALL_TABLES,
    });
  });
});
