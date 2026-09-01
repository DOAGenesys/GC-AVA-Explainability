import 'server-only';

import { sql } from '@vercel/postgres';
import { AppError } from '@/lib/errors';
import { parseTrace, type FlowExecutionTrace, type ParsedTrace } from '../genesys/ava';

/**
 * Postgres access. Plain parameterised SQL rather than an ORM: the interesting queries here are
 * aggregations over three sources with deliberately different coverage, and expressing "sessions
 * analytics can see that execution history cannot" is clearer in SQL than through a query builder.
 */

export function assertDatabaseConfigured(): void {
  if (!process.env.POSTGRES_URL) throw new AppError('DATABASE_NOT_CONFIGURED');
}

/** Tables the read paths depend on. Probed by name so a partial schema is reported, not guessed. */
const REQUIRED_TABLES = [
  'ava_flows',
  'ava_sessions',
  'ava_turns',
  'ava_executions',
  'ava_tool_calls',
  'ingest_runs',
] as const;

export type DatabaseStatus =
  | { state: 'ready' }
  | { state: 'not-configured' }
  | { state: 'schema-missing'; missingTables: string[] }
  | { state: 'unreachable' };

/**
 * Cheap pre-flight for the read pages.
 *
 * Without this a fresh deployment that has POSTGRES_URL but has never had the schema applied throws
 * an undefined-table error from deep inside an aggregation, which a Server Component surfaces to the
 * browser as an unexplained 500. Probing first turns that into a setup instruction.
 */
export async function getDatabaseStatus(): Promise<DatabaseStatus> {
  if (!process.env.POSTGRES_URL) return { state: 'not-configured' };

  try {
    // to_regclass returns NULL instead of erroring for a table that does not exist, so one
    // round-trip classifies the whole schema.
    const { rows } = await sql<Record<string, string | null>>`
      SELECT
        to_regclass('ava_flows')::text      AS ava_flows,
        to_regclass('ava_sessions')::text   AS ava_sessions,
        to_regclass('ava_turns')::text      AS ava_turns,
        to_regclass('ava_executions')::text AS ava_executions,
        to_regclass('ava_tool_calls')::text AS ava_tool_calls,
        to_regclass('ingest_runs')::text    AS ingest_runs
    `;

    const present = rows[0] ?? {};
    const missingTables = REQUIRED_TABLES.filter((table) => !present[table]);
    return missingTables.length > 0
      ? { state: 'schema-missing', missingTables }
      : { state: 'ready' };
  } catch {
    // Connection refused, bad credentials, exhausted pool: all the same instruction for the reader.
    return { state: 'unreachable' };
  }
}

function nullableTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseStoredTrace(value: unknown): ParsedTrace | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    return parseTrace(value as FlowExecutionTrace);
  } catch {
    return null;
  }
}

export interface AvaFlowOption {
  flowId: string;
  name: string;
  flowType: string | null;
}

/** Known AVA flows offered as suggestions without preventing a user from pasting any flow id. */
export async function listAvaFlowOptions(): Promise<AvaFlowOption[]> {
  const { rows } = await sql<{ flow_id: string; name: string; flow_type: string | null }>`
    WITH candidates AS (
      SELECT flow_id, name, flow_type, 0 AS priority
      FROM ava_flows
      WHERE ava_enabled
      UNION ALL
      SELECT flow_id, coalesce(flow_name, 'Captured flow') AS name, NULL AS flow_type, 1 AS priority
      FROM ava_executions
      WHERE flow_id IS NOT NULL
    ),
    known AS (
      SELECT DISTINCT ON (flow_id) flow_id, name, flow_type
      FROM candidates
      ORDER BY flow_id, priority
    )
    SELECT flow_id, name, flow_type
    FROM known
    ORDER BY name, flow_id
  `;
  return rows.map((row) => ({
    flowId: row.flow_id,
    name: row.name,
    flowType: row.flow_type,
  }));
}

export interface ExecutionRecord {
  executionId: string;
  flowId: string | null;
  conversationId: string | null;
  sessionId: string | null;
  retrievalStatus: 'ARCHIVED' | 'NO_HISTORY' | 'DOWNLOAD_FAILED';
  jobsStatusCode: string | null;
  apiCallsPerExecution: number | null;
  bytes: number;
  trace: ParsedTrace | null;
  rawTrace: unknown;
}

export async function upsertExecution(record: ExecutionRecord): Promise<void> {
  const t = record.trace;
  await sql`
    INSERT INTO ava_executions (execution_id, flow_id, flow_name, flow_version, conversation_id,
      session_id, start_date_time, end_date_time, duration_ms, truncated, error_count,
      warning_count, tool_call_count, item_count, retrieval_status, jobs_status_code,
      api_calls_per_execution, bytes, trace, retrieved_at)
    VALUES (
      ${record.executionId},
      ${t?.flowId ?? record.flowId},
      ${t?.flowName ?? null},
      ${t?.flowVersion ?? null},
      ${t?.conversationId ?? record.conversationId},
      ${record.sessionId},
      ${nullableTimestamp(t?.startDateTime)},
      ${nullableTimestamp(t?.endDateTime)},
      ${t?.durationMs ?? null},
      ${t?.truncated ?? false},
      ${t?.errorCount ?? 0},
      ${t?.warningCount ?? 0},
      ${t?.toolCalls.length ?? 0},
      ${t?.items.length ?? 0},
      ${record.retrievalStatus},
      ${record.jobsStatusCode},
      ${record.apiCallsPerExecution},
      ${record.bytes},
      ${record.rawTrace ? JSON.stringify(record.rawTrace) : null},
      ${record.retrievalStatus === 'ARCHIVED' ? new Date().toISOString() : null}
    )
    ON CONFLICT (execution_id) DO UPDATE SET
      retrieval_status = CASE
        WHEN ava_executions.retrieval_status IN ('ARCHIVED', 'NO_HISTORY')
          THEN ava_executions.retrieval_status
        ELSE EXCLUDED.retrieval_status
      END,
      jobs_status_code = EXCLUDED.jobs_status_code,
      -- A retry that finally succeeds must not lose the count of what it took to get there.
      retrieval_attempts = ava_executions.retrieval_attempts + 1,
      api_calls_per_execution = EXCLUDED.api_calls_per_execution,
      -- Never overwrite a good trace with a null from a later failed attempt.
      trace = COALESCE(EXCLUDED.trace, ava_executions.trace),
      flow_id = COALESCE(EXCLUDED.flow_id, ava_executions.flow_id),
      flow_name = COALESCE(EXCLUDED.flow_name, ava_executions.flow_name),
      flow_version = COALESCE(EXCLUDED.flow_version, ava_executions.flow_version),
      conversation_id = COALESCE(EXCLUDED.conversation_id, ava_executions.conversation_id),
      session_id = COALESCE(EXCLUDED.session_id, ava_executions.session_id),
      start_date_time = COALESCE(EXCLUDED.start_date_time, ava_executions.start_date_time),
      end_date_time = COALESCE(EXCLUDED.end_date_time, ava_executions.end_date_time),
      duration_ms = COALESCE(EXCLUDED.duration_ms, ava_executions.duration_ms),
      error_count = GREATEST(EXCLUDED.error_count, ava_executions.error_count),
      warning_count = GREATEST(EXCLUDED.warning_count, ava_executions.warning_count),
      tool_call_count = GREATEST(EXCLUDED.tool_call_count, ava_executions.tool_call_count),
      item_count = GREATEST(EXCLUDED.item_count, ava_executions.item_count),
      truncated = EXCLUDED.truncated OR ava_executions.truncated,
      bytes = GREATEST(EXCLUDED.bytes, ava_executions.bytes),
      retrieved_at = COALESCE(EXCLUDED.retrieved_at, ava_executions.retrieved_at)
  `;

  if (!t) return;

  for (const call of t.toolCalls) {
    await sql`
      INSERT INTO ava_tool_calls (execution_id, ordinal, flow_id, conversation_id, tool_name,
        category, succeeded, output_path_reason, output_path_reason_value, latency_ms, occurred_at,
        inputs, outputs)
      VALUES (${record.executionId}, ${call.ordinal}, ${t.flowId}, ${t.conversationId},
        ${call.toolName}, ${call.category}, ${call.succeeded}, ${call.outputPathReason},
        ${call.outputPathReasonValue}, ${call.latencyMs}, ${nullableTimestamp(call.at)},
        ${JSON.stringify(call.inputs)}, ${JSON.stringify(call.outputs)})
      -- Every column is refreshed, not just the outcome. The ordinal counts tool calls, so what a
      -- given ordinal refers to can change when the parser improves; updating the outcome while
      -- leaving the old name and inputs in place would silently fabricate a row that never happened.
      ON CONFLICT (execution_id, ordinal) DO UPDATE SET
        flow_id = EXCLUDED.flow_id,
        conversation_id = EXCLUDED.conversation_id,
        tool_name = EXCLUDED.tool_name,
        category = EXCLUDED.category,
        succeeded = EXCLUDED.succeeded,
        output_path_reason = EXCLUDED.output_path_reason,
        output_path_reason_value = EXCLUDED.output_path_reason_value,
        latency_ms = EXCLUDED.latency_ms,
        occurred_at = EXCLUDED.occurred_at,
        inputs = EXCLUDED.inputs,
        outputs = EXCLUDED.outputs
    `;
  }

  // A re-parse can yield fewer calls than an earlier pass recorded. Upserting alone would leave the
  // surplus rows behind, where they would keep being counted as tool calls that happened.
  await sql`
    DELETE FROM ava_tool_calls
    WHERE execution_id = ${record.executionId} AND ordinal >= ${t.toolCalls.length}
  `;
}

/**
 * Atomically claim execution IDs before spending Jobs budget.
 *
 * The status doubles as a five-minute lease. Concurrent tabs cannot both move the same row into
 * FETCHING, while a serverless interruption can recover after the lease expires.
 */
export async function claimExecutions(
  records: Pick<ExecutionRecord, 'executionId' | 'flowId' | 'conversationId'>[],
): Promise<Set<string>> {
  const claimed = new Set<string>();
  await Promise.all(
    records.map(async (record) => {
      const inserted = await sql<{ execution_id: string }>`
        INSERT INTO ava_executions (
          execution_id, flow_id, conversation_id, retrieval_status, retrieval_attempts,
          retrieved_at
        )
        VALUES (
          ${record.executionId}, ${record.flowId}, ${record.conversationId}, 'FETCHING', 0,
          now()
        )
        ON CONFLICT (execution_id) DO NOTHING
        RETURNING execution_id
      `;
      if (inserted.rows[0]) {
        claimed.add(inserted.rows[0].execution_id);
        return;
      }

      const retried = await sql<{ execution_id: string }>`
        UPDATE ava_executions
        SET retrieval_status = 'FETCHING',
            retrieved_at = now(),
            flow_id = COALESCE(flow_id, ${record.flowId}),
            conversation_id = COALESCE(conversation_id, ${record.conversationId})
        WHERE execution_id = ${record.executionId}
          AND (
            retrieval_status IN ('DOWNLOAD_FAILED', 'PENDING')
            OR (
              retrieval_status = 'FETCHING'
              AND retrieved_at < now() - interval '5 minutes'
            )
          )
        RETURNING execution_id
      `;
      if (retried.rows[0]) claimed.add(retried.rows[0].execution_id);
    }),
  );
  return claimed;
}

export interface CapturedSessionRecord {
  executionId: string;
  flowId: string;
  conversationId: string;
  trace: ParsedTrace | null;
  noHistory: boolean;
}

/**
 * Make a terminal Jobs result addressable in Sessions.
 *
 * Existing analytics sessions keep their richer platform classification. Otherwise the execution
 * id is a stable synthetic session id, and only facts present in execution history are stored.
 */
export async function upsertCapturedSession(record: CapturedSessionRecord): Promise<string> {
  const existing = await sql<{ session_id: string }>`
    SELECT session_id
    FROM ava_sessions
    WHERE conversation_id = ${record.conversationId}
      AND flow_id = ${record.flowId}
    ORDER BY date_created DESC NULLS LAST, ingested_at DESC
    LIMIT 1
  `;
  if (existing.rows[0]) return existing.rows[0].session_id;

  const sessionId = record.executionId;
  const result = record.trace?.flowExitReason ?? (record.noHistory ? 'No history' : 'Completed');
  const startedAt = nullableTimestamp(record.trace?.startDateTime) ?? new Date().toISOString();
  await sql`
    INSERT INTO ava_sessions (
      session_id, flow_id, conversation_id, bot_result, bot_result_category,
      date_created, date_completed
    )
    VALUES (
      ${sessionId}, ${record.flowId}, ${record.conversationId}, ${result},
      'Execution capture', ${startedAt},
      ${nullableTimestamp(record.trace?.endDateTime)}
    )
    ON CONFLICT (session_id) DO UPDATE SET
      flow_id = EXCLUDED.flow_id,
      conversation_id = EXCLUDED.conversation_id,
      bot_result = EXCLUDED.bot_result,
      bot_result_category = EXCLUDED.bot_result_category,
      date_created = COALESCE(EXCLUDED.date_created, ava_sessions.date_created),
      date_completed = COALESCE(EXCLUDED.date_completed, ava_sessions.date_completed),
      ingested_at = now()
  `;
  return sessionId;
}

export interface CaptureRunRecord {
  kind: string;
  startedAt: Date;
  ok: boolean;
  apiCalls: number;
  rateLimited: number;
  executionsDiscovered?: number;
  executionsRetrieved?: number;
  executionsNoHistory?: number;
  apiCallsPerExecution?: number | null;
  error?: string | null;
  detail?: unknown;
}

export async function recordCaptureRun(run: CaptureRunRecord): Promise<void> {
  const finishedAt = new Date();
  await sql`
    INSERT INTO ingest_runs (kind, started_at, finished_at, duration_ms, ok, api_calls,
      rate_limited, flows_scanned, sessions_seen, turns_seen, executions_discovered,
      executions_retrieved, executions_no_history, api_calls_per_execution, error, detail)
    VALUES (${run.kind}, ${run.startedAt.toISOString()}, ${finishedAt.toISOString()},
      ${finishedAt.getTime() - run.startedAt.getTime()}, ${run.ok}, ${run.apiCalls},
      ${run.rateLimited}, 0, 0, 0, ${run.executionsDiscovered ?? 0},
      ${run.executionsRetrieved ?? 0},
      ${run.executionsNoHistory ?? 0}, ${run.apiCallsPerExecution ?? null},
      ${run.error ?? null}, ${run.detail ? JSON.stringify(run.detail) : null})
  `;
}

// --------------------------------------------------------------------------- dashboard reads

export interface OverviewMetrics {
  sessions: number;
  conversations: number;
  turns: number;
  executionsArchived: number;
  executionsNoHistory: number;
  toolCalls: number;
  toolFailures: number;
  truncatedTraces: number;
  apiCalls24h: number;
  apiCallsPerExecution: number | null;
  containmentRate: number | null;
}

export async function getOverviewMetrics(days: number): Promise<OverviewMetrics> {
  const { rows } = await sql<{
    sessions: string;
    conversations: string;
    turns: string;
    archived: string;
    no_history: string;
    tool_calls: string;
    tool_failures: string;
    truncated: string;
    api_calls: string;
    calls_per_execution: string | null;
    contained: string;
  }>`
    WITH window_sessions AS (
      SELECT * FROM ava_sessions WHERE date_created > now() - (${days} || ' days')::interval
    ),
    capture_execution_ids AS (
      SELECT DISTINCT jsonb_array_elements_text(detail->'executionIds') AS execution_id
      FROM ingest_runs
      WHERE kind = 'capture' AND jsonb_typeof(detail->'executionIds') = 'array'
    )
    SELECT
      (SELECT count(*) FROM window_sessions) AS sessions,
      (SELECT count(DISTINCT conversation_id) FROM window_sessions) AS conversations,
      (SELECT count(*) FROM ava_turns WHERE turn_start > now() - (${days} || ' days')::interval) AS turns,
      (SELECT count(*) FROM ava_executions
        WHERE retrieval_status = 'ARCHIVED'
          AND execution_id IN (SELECT execution_id FROM capture_execution_ids)
          AND first_seen_at > now() - (${days} || ' days')::interval) AS archived,
      (SELECT count(*) FROM ava_executions
        WHERE retrieval_status = 'NO_HISTORY'
          AND execution_id IN (SELECT execution_id FROM capture_execution_ids)
          AND first_seen_at > now() - (${days} || ' days')::interval) AS no_history,
      (SELECT count(*) FROM ava_tool_calls
        WHERE occurred_at > now() - (${days} || ' days')::interval
          AND EXISTS (
            SELECT 1 FROM ava_executions e
            WHERE e.execution_id = ava_tool_calls.execution_id
              AND e.execution_id IN (SELECT execution_id FROM capture_execution_ids)
          )) AS tool_calls,
      (SELECT count(*) FROM ava_tool_calls
        WHERE NOT succeeded AND occurred_at > now() - (${days} || ' days')::interval
          AND EXISTS (
            SELECT 1 FROM ava_executions e
            WHERE e.execution_id = ava_tool_calls.execution_id
              AND e.execution_id IN (SELECT execution_id FROM capture_execution_ids)
          )) AS tool_failures,
      (SELECT count(*) FROM ava_executions
        WHERE truncated
          AND execution_id IN (SELECT execution_id FROM capture_execution_ids)
          AND first_seen_at > now() - (${days} || ' days')::interval) AS truncated,
      (SELECT coalesce(sum(api_calls), 0) FROM ingest_runs
        WHERE kind = 'capture' AND started_at > now() - interval '24 hours') AS api_calls,
      (SELECT round(avg(api_calls_per_execution), 3) FROM ingest_runs
        WHERE kind = 'capture' AND api_calls_per_execution IS NOT NULL
          AND started_at > now() - (${days} || ' days')::interval) AS calls_per_execution,
      (SELECT count(*) FROM window_sessions
        WHERE bot_result_category IN ('Containment', 'Contained')) AS contained
  `;

  const row = rows[0];
  const sessions = Number(row?.sessions ?? 0);
  return {
    sessions,
    conversations: Number(row?.conversations ?? 0),
    turns: Number(row?.turns ?? 0),
    executionsArchived: Number(row?.archived ?? 0),
    executionsNoHistory: Number(row?.no_history ?? 0),
    toolCalls: Number(row?.tool_calls ?? 0),
    toolFailures: Number(row?.tool_failures ?? 0),
    truncatedTraces: Number(row?.truncated ?? 0),
    apiCalls24h: Number(row?.api_calls ?? 0),
    apiCallsPerExecution: row?.calls_per_execution ? Number(row.calls_per_execution) : null,
    containmentRate: sessions > 0 ? Number(row?.contained ?? 0) / sessions : null,
  };
}

export interface OutcomeSlice {
  category: string;
  count: number;
}

export async function getOutcomeBreakdown(days: number): Promise<OutcomeSlice[]> {
  const { rows } = await sql<{ category: string | null; count: string }>`
    SELECT bot_result_category AS category, count(*) AS count
    FROM ava_sessions
    WHERE date_created > now() - (${days} || ' days')::interval
    GROUP BY 1 ORDER BY 2 DESC
  `;
  return rows.map((r) => ({ category: r.category ?? 'Unclassified', count: Number(r.count) }));
}

export interface ToolStat {
  toolName: string;
  calls: number;
  failures: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

export async function getToolStats(days: number): Promise<ToolStat[]> {
  const { rows } = await sql<{
    tool_name: string;
    calls: string;
    failures: string;
    p50: string | null;
    p95: string | null;
  }>`
    WITH capture_execution_ids AS (
      SELECT DISTINCT jsonb_array_elements_text(detail->'executionIds') AS execution_id
      FROM ingest_runs
      WHERE kind = 'capture' AND jsonb_typeof(detail->'executionIds') = 'array'
    )
    SELECT tool_name,
           count(*) AS calls,
           count(*) FILTER (WHERE NOT succeeded) AS failures,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
    FROM ava_tool_calls t
    WHERE occurred_at > now() - (${days} || ' days')::interval
      AND EXISTS (
        SELECT 1 FROM ava_executions e
        WHERE e.execution_id = t.execution_id
          AND e.execution_id IN (SELECT execution_id FROM capture_execution_ids)
      )
    GROUP BY 1
    ORDER BY calls DESC
    LIMIT 50
  `;
  return rows.map((r) => ({
    toolName: r.tool_name,
    calls: Number(r.calls),
    failures: Number(r.failures),
    p50LatencyMs: r.p50 != null ? Number(r.p50) : null,
    p95LatencyMs: r.p95 != null ? Number(r.p95) : null,
  }));
}

export interface SessionRow {
  sessionId: string;
  flowId: string;
  flowName: string | null;
  conversationId: string | null;
  botResult: string | null;
  botResultCategory: string | null;
  dateCreated: string | null;
  turnCount: number;
  executionId: string | null;
  retrievalStatus: string | null;
  toolCallCount: number;
  source: 'analytics' | 'capture';
}

export async function listSessions(days: number, limit: number): Promise<SessionRow[]> {
  const { rows } = await sql<{
    session_id: string;
    flow_id: string;
    flow_name: string | null;
    conversation_id: string | null;
    bot_result: string | null;
    bot_result_category: string | null;
    date_created: string | null;
    turn_count: string;
    execution_id: string | null;
    retrieval_status: string | null;
    tool_call_count: string | null;
    trace: unknown;
    source: 'analytics' | 'capture';
  }>`
    WITH capture_execution_ids AS (
      SELECT DISTINCT jsonb_array_elements_text(detail->'executionIds') AS execution_id
      FROM ingest_runs
      WHERE kind = 'capture' AND jsonb_typeof(detail->'executionIds') = 'array'
    ),
    analytics_sessions AS (
      SELECT s.session_id, s.flow_id, coalesce(f.name, e.flow_name) AS flow_name,
             s.conversation_id, s.bot_result, s.bot_result_category, s.date_created,
             (SELECT count(*) FROM ava_turns t WHERE t.session_id = s.session_id) AS turn_count,
             e.execution_id, e.retrieval_status, e.tool_call_count, e.trace,
             CASE
               WHEN s.bot_result_category = 'Execution capture' THEN 'capture'
               ELSE 'analytics'
             END AS source
      FROM ava_sessions s
      LEFT JOIN ava_flows f ON f.flow_id = s.flow_id
      LEFT JOIN LATERAL (
        SELECT execution_id, flow_name, retrieval_status, tool_call_count, trace
        FROM ava_executions x
        WHERE x.conversation_id = s.conversation_id
        ORDER BY
          (x.execution_id IN (SELECT execution_id FROM capture_execution_ids)) DESC,
          (x.flow_id = s.flow_id) DESC NULLS LAST,
          x.start_date_time DESC NULLS LAST
        LIMIT 1
      ) e ON TRUE
      WHERE s.date_created > now() - (${days} || ' days')::interval
    ),
    captured_sessions AS (
      SELECT e.execution_id AS session_id, coalesce(e.flow_id, 'unknown') AS flow_id,
             coalesce(e.flow_name, f.name) AS flow_name, e.conversation_id,
             NULL::text AS bot_result, NULL::text AS bot_result_category,
             coalesce(e.start_date_time, e.first_seen_at) AS date_created,
             0::bigint AS turn_count, e.execution_id, e.retrieval_status, e.tool_call_count,
             e.trace, 'capture'::text AS source
      FROM ava_executions e
      LEFT JOIN ava_flows f ON f.flow_id = e.flow_id
      WHERE e.execution_id IN (SELECT execution_id FROM capture_execution_ids)
        AND e.retrieval_status IN ('ARCHIVED', 'NO_HISTORY')
        AND coalesce(e.start_date_time, e.first_seen_at) >
            now() - (${days} || ' days')::interval
        AND NOT EXISTS (
          SELECT 1
          FROM ava_sessions s
          WHERE s.session_id = e.session_id
             OR (
               s.conversation_id = e.conversation_id
               AND s.flow_id = e.flow_id
             )
        )
    )
    SELECT * FROM (
      SELECT * FROM analytics_sessions
      UNION ALL
      SELECT * FROM captured_sessions
    ) sessions
    ORDER BY date_created DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => {
    const trace = parseStoredTrace(row.trace);
    return {
      sessionId: row.session_id,
      flowId: row.flow_id,
      flowName: row.flow_name ?? trace?.flowName ?? null,
      conversationId: row.conversation_id,
      botResult:
        row.bot_result ??
        trace?.flowExitReason ??
        (row.retrieval_status === 'NO_HISTORY' ? 'No history' : 'Completed'),
      botResultCategory:
        row.bot_result_category ?? (row.source === 'capture' ? 'Execution capture' : null),
      dateCreated: row.date_created,
      turnCount: Math.max(Number(row.turn_count), trace?.avaTurns.length ?? 0),
      executionId: row.execution_id,
      retrievalStatus: row.retrieval_status,
      toolCallCount: Number(row.tool_call_count ?? 0),
      source: row.source,
    };
  });
}

export interface CoverageReport {
  sessions: number;
  sessionsWithExecution: number;
  sessionsWithoutExecution: number;
  sessionsWithNoHistory: number;
  sessionsWithTurns: number;
  byCategory: { category: string; sessions: number; withExecution: number }[];
}

/**
 * The coverage question this whole app exists to answer: how much of what the AVA actually did is
 * visible at full fidelity, and how much is only visible as analytics?
 */
export async function getCoverageReport(days: number): Promise<CoverageReport> {
  const { rows: totals } = await sql<{
    sessions: string;
    with_execution: string;
    with_no_history: string;
    with_turns: string;
  }>`
    WITH w AS (
      SELECT * FROM ava_sessions WHERE date_created > now() - (${days} || ' days')::interval
    )
    SELECT
      count(*) AS sessions,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM ava_executions e
        WHERE e.conversation_id = w.conversation_id AND e.retrieval_status = 'ARCHIVED'
      )) AS with_execution,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM ava_executions e
        WHERE e.conversation_id = w.conversation_id AND e.retrieval_status = 'NO_HISTORY'
      )) AS with_no_history,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM ava_turns t WHERE t.session_id = w.session_id
      )) AS with_turns
    FROM w
  `;

  const { rows: byCategory } = await sql<{
    category: string | null;
    sessions: string;
    with_execution: string;
  }>`
    WITH w AS (
      SELECT * FROM ava_sessions WHERE date_created > now() - (${days} || ' days')::interval
    )
    SELECT bot_result_category AS category,
           count(*) AS sessions,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM ava_executions e
             WHERE e.conversation_id = w.conversation_id AND e.retrieval_status = 'ARCHIVED'
           )) AS with_execution
    FROM w
    GROUP BY 1 ORDER BY 2 DESC
  `;

  const row = totals[0];
  const sessions = Number(row?.sessions ?? 0);
  const withExecution = Number(row?.with_execution ?? 0);
  return {
    sessions,
    sessionsWithExecution: withExecution,
    sessionsWithoutExecution: sessions - withExecution,
    sessionsWithNoHistory: Number(row?.with_no_history ?? 0),
    sessionsWithTurns: Number(row?.with_turns ?? 0),
    byCategory: byCategory.map((r) => ({
      category: r.category ?? 'Unclassified',
      sessions: Number(r.sessions),
      withExecution: Number(r.with_execution),
    })),
  };
}

export interface CaptureCoverageReport {
  observed: number;
  archived: number;
  noHistory: number;
  failed: number;
  truncated: number;
  byFlow: {
    flowId: string;
    flowName: string | null;
    observed: number;
    archived: number;
    noHistory: number;
    failed: number;
  }[];
}

/** Retrieval outcomes for executions actually observed by live capture; no unseen denominator. */
export async function getCaptureCoverage(days: number): Promise<CaptureCoverageReport> {
  const { rows } = await sql<{
    flow_id: string | null;
    flow_name: string | null;
    observed: string;
    archived: string;
    no_history: string;
    failed: string;
    truncated: string;
  }>`
    WITH capture_execution_ids AS (
      SELECT DISTINCT jsonb_array_elements_text(detail->'executionIds') AS execution_id
      FROM ingest_runs
      WHERE kind = 'capture' AND jsonb_typeof(detail->'executionIds') = 'array'
    )
    SELECT flow_id, max(flow_name) AS flow_name, count(*) AS observed,
           count(*) FILTER (WHERE retrieval_status = 'ARCHIVED') AS archived,
           count(*) FILTER (WHERE retrieval_status = 'NO_HISTORY') AS no_history,
           count(*) FILTER (WHERE retrieval_status = 'DOWNLOAD_FAILED') AS failed,
           count(*) FILTER (WHERE truncated) AS truncated
    FROM ava_executions
    WHERE first_seen_at > now() - (${days} || ' days')::interval
      AND execution_id IN (SELECT execution_id FROM capture_execution_ids)
    GROUP BY flow_id
    ORDER BY count(*) DESC, flow_id
  `;

  const byFlow = rows.map((row) => ({
    flowId: row.flow_id ?? 'unknown',
    flowName: row.flow_name,
    observed: Number(row.observed),
    archived: Number(row.archived),
    noHistory: Number(row.no_history),
    failed: Number(row.failed),
  }));

  return {
    observed: byFlow.reduce((sum, row) => sum + row.observed, 0),
    archived: byFlow.reduce((sum, row) => sum + row.archived, 0),
    noHistory: byFlow.reduce((sum, row) => sum + row.noHistory, 0),
    failed: byFlow.reduce((sum, row) => sum + row.failed, 0),
    truncated: rows.reduce((sum, row) => sum + Number(row.truncated), 0),
    byFlow,
  };
}

export interface CaptureRunRow {
  id: number;
  kind: string;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  apiCalls: number;
  rateLimited: number;
  executionsRetrieved: number;
  executionsNoHistory: number;
  apiCallsPerExecution: number | null;
  error: string | null;
}

export async function listCaptureRuns(limit: number): Promise<CaptureRunRow[]> {
  const { rows } = await sql<{
    id: number;
    kind: string;
    started_at: string;
    duration_ms: number;
    ok: boolean;
    api_calls: number;
    rate_limited: number;
    executions_retrieved: number;
    executions_no_history: number;
    api_calls_per_execution: string | null;
    error: string | null;
  }>`
    SELECT id, kind, started_at, duration_ms, ok, api_calls, rate_limited, executions_retrieved,
           executions_no_history, api_calls_per_execution, error
    FROM ingest_runs
    WHERE kind = 'capture'
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    startedAt: r.started_at,
    durationMs: r.duration_ms,
    ok: r.ok,
    apiCalls: r.api_calls,
    rateLimited: r.rate_limited,
    executionsRetrieved: r.executions_retrieved,
    executionsNoHistory: r.executions_no_history,
    apiCallsPerExecution: r.api_calls_per_execution ? Number(r.api_calls_per_execution) : null,
    error: r.error,
  }));
}

export interface ExecutionDetail {
  executionId: string;
  flowId: string | null;
  flowName: string | null;
  flowVersion: string | null;
  conversationId: string | null;
  sessionId: string | null;
  retrievalStatus: string;
  jobsStatusCode: string | null;
  durationMs: number | null;
  truncated: boolean;
  trace: unknown;
  parsedTrace: ParsedTrace | null;
}

export async function getExecution(executionId: string): Promise<ExecutionDetail | null> {
  const { rows } = await sql<{
    execution_id: string;
    flow_id: string | null;
    flow_name: string | null;
    flow_version: string | null;
    conversation_id: string | null;
    session_id: string | null;
    retrieval_status: string;
    jobs_status_code: string | null;
    duration_ms: number | null;
    truncated: boolean;
    trace: unknown;
  }>`
    SELECT execution_id, flow_id, flow_name, flow_version, conversation_id, session_id,
           retrieval_status, jobs_status_code, duration_ms, truncated, trace
    FROM ava_executions WHERE execution_id = ${executionId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    executionId: row.execution_id,
    flowId: row.flow_id,
    flowName: row.flow_name,
    flowVersion: row.flow_version,
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    retrievalStatus: row.retrieval_status,
    jobsStatusCode: row.jobs_status_code,
    durationMs: row.duration_ms,
    truncated: row.truncated,
    trace: row.trace,
    parsedTrace: parseStoredTrace(row.trace),
  };
}

export interface SessionDetail {
  sessionId: string;
  flowId: string;
  flowName: string | null;
  conversationId: string | null;
  channelName: string | null;
  language: string | null;
  botResult: string | null;
  botResultCategory: string | null;
  dateCreated: string | null;
  dateCompleted: string | null;
  executionId: string | null;
  retrievalStatus: string | null;
}

export async function getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  const { rows } = await sql<{
    session_id: string;
    flow_id: string;
    flow_name: string | null;
    conversation_id: string | null;
    channel_name: string | null;
    language: string | null;
    bot_result: string | null;
    bot_result_category: string | null;
    date_created: string | null;
    date_completed: string | null;
    execution_id: string | null;
    retrieval_status: string | null;
  }>`
    WITH capture_execution_ids AS (
      SELECT DISTINCT jsonb_array_elements_text(detail->'executionIds') AS execution_id
      FROM ingest_runs
      WHERE kind = 'capture' AND jsonb_typeof(detail->'executionIds') = 'array'
    )
    SELECT s.session_id, s.flow_id, coalesce(f.name, e.flow_name) AS flow_name,
           s.conversation_id, s.channel_name,
           s.language, s.bot_result, s.bot_result_category, s.date_created, s.date_completed,
           e.execution_id, e.retrieval_status
    FROM ava_sessions s
    LEFT JOIN ava_flows f ON f.flow_id = s.flow_id
    -- Same flow-first preference as the list, ahead of the existing bias towards a trace that was
    -- actually archived: showing the wrong flow's trace is worse than showing none.
    LEFT JOIN LATERAL (
      SELECT execution_id, flow_name, retrieval_status
      FROM ava_executions x
      WHERE x.conversation_id = s.conversation_id
      ORDER BY (x.execution_id IN (SELECT execution_id FROM capture_execution_ids)) DESC,
               (x.flow_id = s.flow_id) DESC NULLS LAST,
               x.retrieval_status = 'ARCHIVED' DESC,
               x.start_date_time DESC NULLS LAST
      LIMIT 1
    ) e ON TRUE
    WHERE s.session_id = ${sessionId}
  `;
  const row = rows[0];
  if (row) {
    return {
      sessionId: row.session_id,
      flowId: row.flow_id,
      flowName: row.flow_name,
      conversationId: row.conversation_id,
      channelName: row.channel_name,
      language: row.language,
      botResult: row.bot_result,
      botResultCategory: row.bot_result_category,
      dateCreated: row.date_created,
      dateCompleted: row.date_completed,
      executionId: row.execution_id,
      retrievalStatus: row.retrieval_status,
    };
  }

  const { rows: capturedRows } = await sql<{
    execution_id: string;
    flow_id: string | null;
    flow_name: string | null;
    conversation_id: string | null;
    start_date_time: string | null;
    end_date_time: string | null;
    retrieval_status: string;
    trace: unknown;
  }>`
    WITH capture_execution_ids AS (
      SELECT DISTINCT jsonb_array_elements_text(detail->'executionIds') AS execution_id
      FROM ingest_runs
      WHERE kind = 'capture' AND jsonb_typeof(detail->'executionIds') = 'array'
    )
    SELECT e.execution_id, e.flow_id, e.flow_name, e.conversation_id, e.start_date_time,
           e.end_date_time, e.retrieval_status, e.trace
    FROM ava_executions e
    WHERE e.execution_id = ${sessionId}
      AND e.execution_id IN (SELECT execution_id FROM capture_execution_ids)
      AND e.retrieval_status IN ('ARCHIVED', 'NO_HISTORY')
  `;
  const captured = capturedRows[0];
  if (!captured) return null;

  const trace = parseStoredTrace(captured.trace);
  return {
    sessionId: captured.execution_id,
    flowId: captured.flow_id ?? trace?.flowId ?? 'unknown',
    flowName: captured.flow_name ?? trace?.flowName ?? null,
    conversationId: captured.conversation_id ?? trace?.conversationId ?? null,
    channelName: null,
    language: null,
    botResult:
      trace?.flowExitReason ??
      (captured.retrieval_status === 'NO_HISTORY' ? 'No history' : 'Completed'),
    botResultCategory: 'Execution capture',
    dateCreated: captured.start_date_time ?? trace?.startDateTime ?? null,
    dateCompleted: captured.end_date_time ?? trace?.endDateTime ?? null,
    executionId: captured.execution_id,
    retrievalStatus: captured.retrieval_status,
  };
}

export interface TurnRow {
  turnId: string;
  sequence: number | null;
  askAction: string | null;
  askActionResult: string | null;
  userInput: unknown;
  botPrompts: unknown;
  turnStart: string | null;
  turnEnd: string | null;
}

export async function listTurnsForSession(sessionId: string): Promise<TurnRow[]> {
  const { rows } = await sql<{
    turn_id: string;
    sequence_number: number | null;
    ask_action: string | null;
    ask_action_result: string | null;
    user_input: unknown;
    bot_prompts: unknown;
    turn_start: string | null;
    turn_end: string | null;
  }>`
    SELECT turn_id, sequence_number, ask_action, ask_action_result, user_input, bot_prompts,
           turn_start, turn_end
    FROM ava_turns WHERE session_id = ${sessionId}
    ORDER BY sequence_number NULLS LAST, turn_start NULLS LAST, turn_id
  `;
  return rows.map((r) => ({
    turnId: r.turn_id,
    sequence: r.sequence_number,
    askAction: r.ask_action,
    askActionResult: r.ask_action_result,
    userInput: r.user_input,
    botPrompts: r.bot_prompts,
    turnStart: r.turn_start,
    turnEnd: r.turn_end,
  }));
}

export async function listTurnsForConversation(conversationId: string): Promise<TurnRow[]> {
  const { rows } = await sql<{
    turn_id: string;
    sequence_number: number | null;
    ask_action: string | null;
    ask_action_result: string | null;
    user_input: unknown;
    bot_prompts: unknown;
    turn_start: string | null;
    turn_end: string | null;
  }>`
    SELECT turn_id, sequence_number, ask_action, ask_action_result, user_input, bot_prompts,
           turn_start, turn_end
    FROM ava_turns WHERE conversation_id = ${conversationId}
    ORDER BY sequence_number NULLS LAST, turn_start NULLS LAST, turn_id
  `;
  return rows.map((r) => ({
    turnId: r.turn_id,
    sequence: r.sequence_number,
    askAction: r.ask_action,
    askActionResult: r.ask_action_result,
    userInput: r.user_input,
    botPrompts: r.bot_prompts,
    turnStart: r.turn_start,
    turnEnd: r.turn_end,
  }));
}
