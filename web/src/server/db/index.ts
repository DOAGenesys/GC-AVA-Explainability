import 'server-only';

import { sql } from '@vercel/postgres';
import { AppError } from '@/lib/errors';
import type { AvaFlow, BotFlowSession, ParsedTrace, ReportingTurn } from '../genesys/ava';

/**
 * Postgres access. Plain parameterised SQL rather than an ORM: the interesting queries here are
 * aggregations over three sources with deliberately different coverage, and expressing "sessions
 * analytics can see that execution history cannot" is clearer in SQL than through a query builder.
 */

export function assertDatabaseConfigured(): void {
  if (!process.env.POSTGRES_URL) throw new AppError('DATABASE_NOT_CONFIGURED');
}

function nullableTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// --------------------------------------------------------------------------- writes

export async function upsertFlows(flows: AvaFlow[]): Promise<void> {
  for (const flow of flows) {
    // ava_enabled_changed_at is only touched when the value actually moves, which turns the
    // registry into a drift log rather than just a snapshot.
    await sql`
      INSERT INTO ava_flows (flow_id, name, flow_type, division_id, ava_enabled, published_version)
      VALUES (${flow.flowId}, ${flow.name}, ${flow.flowType}, ${flow.divisionId},
              ${flow.avaEnabled}, ${flow.publishedVersion})
      ON CONFLICT (flow_id) DO UPDATE SET
        name = EXCLUDED.name,
        flow_type = EXCLUDED.flow_type,
        division_id = EXCLUDED.division_id,
        published_version = EXCLUDED.published_version,
        last_seen_at = now(),
        ava_enabled_changed_at = CASE
          WHEN ava_flows.ava_enabled IS DISTINCT FROM EXCLUDED.ava_enabled THEN now()
          ELSE ava_flows.ava_enabled_changed_at
        END,
        ava_enabled = EXCLUDED.ava_enabled
    `;
  }
}

export async function listIngestableFlowIds(explicit: string[]): Promise<string[]> {
  if (explicit.length > 0) return explicit;
  const { rows } = await sql<{ flow_id: string }>`
    SELECT flow_id FROM ava_flows WHERE ava_enabled ORDER BY last_seen_at DESC
  `;
  return rows.map((r) => r.flow_id);
}

export async function upsertSessions(sessions: BotFlowSession[]): Promise<void> {
  for (const s of sessions) {
    await sql`
      INSERT INTO ava_sessions (session_id, flow_id, conversation_id, channel_name, language,
                                end_language, bot_result, bot_result_category, date_created,
                                date_completed)
      VALUES (${s.sessionId}, ${s.flowId}, ${s.conversationId}, ${s.channelName}, ${s.language},
              ${s.endLanguage}, ${s.botResult}, ${s.botResultCategory},
              ${nullableTimestamp(s.dateCreated)}, ${nullableTimestamp(s.dateCompleted)})
      ON CONFLICT (session_id) DO UPDATE SET
        bot_result = EXCLUDED.bot_result,
        bot_result_category = EXCLUDED.bot_result_category,
        end_language = EXCLUDED.end_language,
        date_completed = EXCLUDED.date_completed,
        ingested_at = now()
    `;
  }
}

export async function upsertTurns(turns: ReportingTurn[]): Promise<void> {
  for (const t of turns) {
    await sql`
      INSERT INTO ava_turns (turn_id, session_id, flow_id, conversation_id, sequence_number,
                             ask_action, ask_action_result, user_input, bot_prompts, turn_start,
                             turn_end, raw)
      VALUES (${t.turnId}, ${t.sessionId}, ${t.flowId}, ${t.conversationId}, ${t.sequence},
              ${t.askAction}, ${t.askActionResult}, ${JSON.stringify(t.userInput)},
              ${JSON.stringify(t.botPrompts)}, ${nullableTimestamp(t.turnStart)},
              ${nullableTimestamp(t.turnEnd)}, ${JSON.stringify(t.raw)})
      ON CONFLICT (turn_id) DO UPDATE SET
        ask_action_result = EXCLUDED.ask_action_result,
        bot_prompts = EXCLUDED.bot_prompts,
        turn_end = EXCLUDED.turn_end,
        raw = EXCLUDED.raw,
        ingested_at = now()
    `;
  }
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
      retrieval_status = EXCLUDED.retrieval_status,
      jobs_status_code = EXCLUDED.jobs_status_code,
      -- A retry that finally succeeds must not lose the count of what it took to get there.
      retrieval_attempts = ava_executions.retrieval_attempts + 1,
      api_calls_per_execution = EXCLUDED.api_calls_per_execution,
      -- Never overwrite a good trace with a null from a later failed attempt.
      trace = COALESCE(EXCLUDED.trace, ava_executions.trace),
      flow_name = COALESCE(EXCLUDED.flow_name, ava_executions.flow_name),
      duration_ms = COALESCE(EXCLUDED.duration_ms, ava_executions.duration_ms),
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
      ON CONFLICT (execution_id, ordinal) DO UPDATE SET
        succeeded = EXCLUDED.succeeded,
        outputs = EXCLUDED.outputs,
        latency_ms = EXCLUDED.latency_ms
    `;
  }
}

/** Attach discovered execution ids to their session, so coverage can be computed per session. */
export async function linkExecutionToSession(
  conversationId: string,
  executionId: string,
): Promise<void> {
  await sql`
    UPDATE ava_executions e
    SET session_id = s.session_id
    FROM ava_sessions s
    WHERE e.execution_id = ${executionId}
      AND s.conversation_id = ${conversationId}
      AND e.session_id IS NULL
  `;
}

export interface IngestRunRecord {
  kind: string;
  startedAt: Date;
  ok: boolean;
  apiCalls: number;
  rateLimited: number;
  flowsScanned?: number;
  sessionsSeen?: number;
  turnsSeen?: number;
  executionsDiscovered?: number;
  executionsRetrieved?: number;
  executionsNoHistory?: number;
  apiCallsPerExecution?: number | null;
  error?: string | null;
  detail?: unknown;
}

export async function recordIngestRun(run: IngestRunRecord): Promise<void> {
  const finishedAt = new Date();
  await sql`
    INSERT INTO ingest_runs (kind, started_at, finished_at, duration_ms, ok, api_calls,
      rate_limited, flows_scanned, sessions_seen, turns_seen, executions_discovered,
      executions_retrieved, executions_no_history, api_calls_per_execution, error, detail)
    VALUES (${run.kind}, ${run.startedAt.toISOString()}, ${finishedAt.toISOString()},
      ${finishedAt.getTime() - run.startedAt.getTime()}, ${run.ok}, ${run.apiCalls},
      ${run.rateLimited}, ${run.flowsScanned ?? 0}, ${run.sessionsSeen ?? 0},
      ${run.turnsSeen ?? 0}, ${run.executionsDiscovered ?? 0}, ${run.executionsRetrieved ?? 0},
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
    )
    SELECT
      (SELECT count(*) FROM window_sessions) AS sessions,
      (SELECT count(DISTINCT conversation_id) FROM window_sessions) AS conversations,
      (SELECT count(*) FROM ava_turns WHERE turn_start > now() - (${days} || ' days')::interval) AS turns,
      (SELECT count(*) FROM ava_executions
        WHERE retrieval_status = 'ARCHIVED'
          AND first_seen_at > now() - (${days} || ' days')::interval) AS archived,
      (SELECT count(*) FROM ava_executions
        WHERE retrieval_status = 'NO_HISTORY'
          AND first_seen_at > now() - (${days} || ' days')::interval) AS no_history,
      (SELECT count(*) FROM ava_tool_calls
        WHERE occurred_at > now() - (${days} || ' days')::interval) AS tool_calls,
      (SELECT count(*) FROM ava_tool_calls
        WHERE NOT succeeded AND occurred_at > now() - (${days} || ' days')::interval) AS tool_failures,
      (SELECT count(*) FROM ava_executions
        WHERE truncated AND first_seen_at > now() - (${days} || ' days')::interval) AS truncated,
      (SELECT coalesce(sum(api_calls), 0) FROM ingest_runs
        WHERE started_at > now() - interval '24 hours') AS api_calls,
      (SELECT round(avg(api_calls_per_execution), 3) FROM ingest_runs
        WHERE api_calls_per_execution IS NOT NULL
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
    SELECT tool_name,
           count(*) AS calls,
           count(*) FILTER (WHERE NOT succeeded) AS failures,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
    FROM ava_tool_calls
    WHERE occurred_at > now() - (${days} || ' days')::interval
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
  }>`
    SELECT s.session_id, s.flow_id, f.name AS flow_name, s.conversation_id, s.bot_result,
           s.bot_result_category, s.date_created,
           (SELECT count(*) FROM ava_turns t WHERE t.session_id = s.session_id) AS turn_count,
           e.execution_id, e.retrieval_status, e.tool_call_count
    FROM ava_sessions s
    LEFT JOIN ava_flows f ON f.flow_id = s.flow_id
    -- At most one execution per session; the newest wins if a conversation re-entered the flow.
    LEFT JOIN LATERAL (
      SELECT execution_id, retrieval_status, tool_call_count
      FROM ava_executions x
      WHERE x.conversation_id = s.conversation_id
      ORDER BY x.start_date_time DESC NULLS LAST
      LIMIT 1
    ) e ON TRUE
    WHERE s.date_created > now() - (${days} || ' days')::interval
    ORDER BY s.date_created DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    sessionId: r.session_id,
    flowId: r.flow_id,
    flowName: r.flow_name,
    conversationId: r.conversation_id,
    botResult: r.bot_result,
    botResultCategory: r.bot_result_category,
    dateCreated: r.date_created,
    turnCount: Number(r.turn_count),
    executionId: r.execution_id,
    retrievalStatus: r.retrieval_status,
    toolCallCount: Number(r.tool_call_count ?? 0),
  }));
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

export interface IngestRunRow {
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

export async function listIngestRuns(limit: number): Promise<IngestRunRow[]> {
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
    FROM ingest_runs ORDER BY started_at DESC LIMIT ${limit}
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
    SELECT s.session_id, s.flow_id, f.name AS flow_name, s.conversation_id, s.channel_name,
           s.language, s.bot_result, s.bot_result_category, s.date_created, s.date_completed,
           e.execution_id, e.retrieval_status
    FROM ava_sessions s
    LEFT JOIN ava_flows f ON f.flow_id = s.flow_id
    LEFT JOIN LATERAL (
      SELECT execution_id, retrieval_status
      FROM ava_executions x
      WHERE x.conversation_id = s.conversation_id
      ORDER BY x.retrieval_status = 'ARCHIVED' DESC, x.start_date_time DESC NULLS LAST
      LIMIT 1
    ) e ON TRUE
    WHERE s.session_id = ${sessionId}
  `;
  const row = rows[0];
  if (!row) return null;
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

export interface TurnRow {
  turnId: string;
  sequence: number | null;
  askAction: string | null;
  askActionResult: string | null;
  userInput: unknown;
  botPrompts: unknown;
  turnStart: string | null;
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
  }>`
    SELECT turn_id, sequence_number, ask_action, ask_action_result, user_input, bot_prompts, turn_start
    FROM ava_turns WHERE session_id = ${sessionId}
    ORDER BY sequence_number NULLS LAST, turn_start
  `;
  return rows.map((r) => ({
    turnId: r.turn_id,
    sequence: r.sequence_number,
    askAction: r.ask_action,
    askActionResult: r.ask_action_result,
    userInput: r.user_input,
    botPrompts: r.bot_prompts,
    turnStart: r.turn_start,
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
  }>`
    SELECT turn_id, sequence_number, ask_action, ask_action_result, user_input, bot_prompts, turn_start
    FROM ava_turns WHERE conversation_id = ${conversationId}
    ORDER BY sequence_number NULLS LAST, turn_start
  `;
  return rows.map((r) => ({
    turnId: r.turn_id,
    sequence: r.sequence_number,
    askAction: r.ask_action,
    askActionResult: r.ask_action_result,
    userInput: r.user_input,
    botPrompts: r.bot_prompts,
    turnStart: r.turn_start,
  }));
}
