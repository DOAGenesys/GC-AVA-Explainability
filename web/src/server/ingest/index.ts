import 'server-only';

import { getServerConfig } from '../config';
import {
  assertDatabaseConfigured,
  linkExecutionToSession,
  listIngestableFlowIds,
  recordIngestRun,
  upsertExecution,
  upsertFlows,
  upsertSessions,
  upsertTurns,
} from '../db';
import {
  findExecutionIds,
  getBotFlowSessions,
  getReportingTurns,
  listAvaFlows,
  lookbackInterval,
  parseTrace,
  retrieveExecutionHistories,
} from '../genesys/ava';
import { newBudget, type Identity } from '../genesys/http';
import { logger } from '../logger';

/**
 * The three ingestion passes, in dependency order.
 *
 * They are separate cron entries rather than one job because they have genuinely different cost
 * profiles and failure modes. The registry pass is a handful of calls every few hours. The triage
 * pass is two calls per flow and must run often, because reporting-turn data is only retained
 * upstream for 10 days and it is the only source that sees conversations execution history cannot.
 * The fidelity pass is the expensive one, and it is deliberately downstream of triage: it never
 * guesses what to fetch, it fetches exactly the executions belonging to conversations triage has
 * already seen.
 *
 * That ordering is what keeps the API cost low. Nothing polls for "what happened"; triage answers
 * that cheaply in bulk, and the expensive per-execution path only ever runs on a known worklist.
 */

const INGESTION: Identity = { kind: 'ingestion' };

export interface PassResult {
  ok: boolean;
  apiCalls: number;
  summary: Record<string, number | string | null>;
}

/**
 * Resolve the flows triage should scan, discovering them inline if the registry has not run yet.
 *
 * The registry pass only runs every six hours, so a freshly deployed database leaves `ava_flows`
 * empty and triage would iterate nothing - silently ingesting zero rows until the first registry
 * tick. Paying for one discovery call on a cold start is much cheaper than losing hours of turn
 * data against a 10-day upstream retention window.
 */
async function resolveTriageFlowIds(
  explicit: string[],
  budget: ReturnType<typeof newBudget>,
): Promise<{ flowIds: string[]; discovered: boolean }> {
  const known = await listIngestableFlowIds(explicit);
  if (known.length > 0 || explicit.length > 0) return { flowIds: known, discovered: false };

  const flows = await listAvaFlows(INGESTION, budget);
  await upsertFlows(flows);
  return {
    flowIds: flows.filter((f) => f.avaEnabled).map((f) => f.flowId),
    discovered: true,
  };
}

// --------------------------------------------------------------------------- registry

/**
 * Refresh which flows are AVA-enabled.
 *
 * Runs on a schedule instead of being configured once because the `agenticVirtualAgentEnabled`
 * flag was observed changing within a single day during validation, as flows were published. A
 * static list silently stops covering flows that became AVA-enabled after deployment.
 */
export async function runRegistryPass(): Promise<PassResult> {
  assertDatabaseConfigured();
  const startedAt = new Date();
  const budget = newBudget();

  try {
    const flows = await listAvaFlows(INGESTION, budget);
    await upsertFlows(flows);
    const avaEnabled = flows.filter((f) => f.avaEnabled).length;

    await recordIngestRun({
      kind: 'registry',
      startedAt,
      ok: true,
      apiCalls: budget.calls,
      rateLimited: budget.rateLimited,
      flowsScanned: flows.length,
      detail: { avaEnabled, byPath: budget.byPath },
    });

    return {
      ok: true,
      apiCalls: budget.calls,
      summary: { flows: flows.length, avaEnabled },
    };
  } catch (err) {
    const message = (err as Error)?.message ?? 'unknown';
    logger.error('ingest.registry.failed', { message });
    await recordIngestRun({
      kind: 'registry',
      startedAt,
      ok: false,
      apiCalls: budget.calls,
      rateLimited: budget.rateLimited,
      error: message,
    });
    return { ok: false, apiCalls: budget.calls, summary: { error: message } };
  }
}

// --------------------------------------------------------------------------- triage

/**
 * The cheap bulk pass: session outcomes and turn transcripts, two calls per flow.
 *
 * This is the coverage spine. It captures every session including the ones that never produced an
 * execution history, and it must run frequently because the upstream retention window on turn data
 * is 10 days - anything not copied here before then is gone permanently.
 */
export async function runTriagePass(): Promise<PassResult> {
  assertDatabaseConfigured();
  const cfg = getServerConfig();
  const startedAt = new Date();
  const budget = newBudget();

  try {
    const { flowIds, discovered } = await resolveTriageFlowIds(cfg.ingestion.flowIds, budget);

    // Nothing to scan is not a success. Left as ok:true this pass reports healthy runs forever
    // while ingesting nothing, which is exactly the silent failure this app exists to surface.
    if (flowIds.length === 0) {
      const error = discovered
        ? 'No AVA-enabled flows found. Check that a flow has agenticVirtualAgentEnabled set and that the ingest credentials can see its division.'
        : 'No AVA-enabled flows are known yet. The registry pass has not populated ava_flows.';
      logger.warn('ingest.triage.no_flows', { discovered });
      await recordIngestRun({
        kind: 'triage',
        startedAt,
        ok: false,
        apiCalls: budget.calls,
        rateLimited: budget.rateLimited,
        flowsScanned: 0,
        error,
        detail: { discovered, byPath: budget.byPath },
      });
      return { ok: false, apiCalls: budget.calls, summary: { flows: 0, error } };
    }

    const interval = lookbackInterval(cfg.ingestion.lookbackMinutes);
    let sessionsSeen = 0;
    let turnsSeen = 0;

    for (const flowId of flowIds) {
      const sessions = await getBotFlowSessions(flowId, interval, INGESTION, budget);
      if (sessions.length > 0) await upsertSessions(sessions);
      sessionsSeen += sessions.length;

      const turns = await getReportingTurns(flowId, interval, INGESTION, budget);
      if (turns.length > 0) await upsertTurns(turns);
      turnsSeen += turns.length;
    }

    await recordIngestRun({
      kind: 'triage',
      startedAt,
      ok: true,
      apiCalls: budget.calls,
      rateLimited: budget.rateLimited,
      flowsScanned: flowIds.length,
      sessionsSeen,
      turnsSeen,
      detail: { interval, discoveredFlowsInline: discovered, byPath: budget.byPath },
    });

    return {
      ok: true,
      apiCalls: budget.calls,
      summary: {
        flows: flowIds.length,
        sessions: sessionsSeen,
        turns: turnsSeen,
        discoveredFlowsInline: discovered ? 1 : 0,
      },
    };
  } catch (err) {
    const message = (err as Error)?.message ?? 'unknown';
    logger.error('ingest.triage.failed', { message });
    await recordIngestRun({
      kind: 'triage',
      startedAt,
      ok: false,
      apiCalls: budget.calls,
      rateLimited: budget.rateLimited,
      error: message,
    });
    return { ok: false, apiCalls: budget.calls, summary: { error: message } };
  }
}

// --------------------------------------------------------------------------- fidelity

/**
 * The expensive pass: full execution history for conversations triage has already seen.
 *
 * Two things keep this affordable. Discovery resolves many conversations per call rather than one,
 * and retrieval batches 10 execution ids per job. An execution the platform holds no history for
 * is recorded as NO_HISTORY rather than retried forever - for an execution that never reached its
 * flow's exit, the 404 is permanent, and the turn-level data captured by triage is the only
 * account of it that will ever exist.
 */
export async function runFidelityPass(): Promise<PassResult> {
  assertDatabaseConfigured();
  const cfg = getServerConfig();
  const startedAt = new Date();
  const budget = newBudget();

  try {
    const { rows: pending } = await pendingConversations(cfg.ingestion.maxExecutionsPerRun);
    if (pending.length === 0) {
      await recordIngestRun({
        kind: 'fidelity',
        startedAt,
        ok: true,
        apiCalls: budget.calls,
        rateLimited: budget.rateLimited,
        detail: { note: 'nothing pending' },
      });
      return { ok: true, apiCalls: 0, summary: { pending: 0 } };
    }

    const conversationIds = pending.map((p) => p.conversation_id);
    const discovered = await findExecutionIds(conversationIds, INGESTION, budget);

    const executionIds: string[] = [];
    const conversationByExecution = new Map<string, string>();
    for (const [conversationId, executions] of discovered) {
      for (const execution of executions) {
        executionIds.push(execution.executionId);
        conversationByExecution.set(execution.executionId, conversationId);
      }
    }

    if (executionIds.length === 0) {
      await recordIngestRun({
        kind: 'fidelity',
        startedAt,
        ok: true,
        apiCalls: budget.calls,
        rateLimited: budget.rateLimited,
        executionsDiscovered: 0,
        detail: {
          conversationsAsked: conversationIds.length,
          // Conversations with sessions but no discoverable execution are the invisible
          // population, and their count is the honest measure of the fidelity gap.
          note: 'no executions found for any pending conversation',
        },
      });
      return { ok: true, apiCalls: budget.calls, summary: { discovered: 0 } };
    }

    const outcome = await retrieveExecutionHistories(executionIds, INGESTION, budget);

    let retrieved = 0;
    let noHistory = 0;

    for (const execution of outcome.executions) {
      const conversationId = conversationByExecution.get(execution.executionId) ?? null;
      const trace = execution.trace ? parseTrace(execution.trace) : null;

      if (execution.noHistory) noHistory += 1;
      else if (trace) retrieved += 1;

      await upsertExecution({
        executionId: execution.executionId,
        flowId: trace?.flowId ?? null,
        conversationId: trace?.conversationId ?? conversationId,
        sessionId: null,
        retrievalStatus: execution.noHistory
          ? 'NO_HISTORY'
          : trace
            ? 'ARCHIVED'
            : 'DOWNLOAD_FAILED',
        jobsStatusCode: execution.statusCode,
        apiCallsPerExecution: outcome.apiCallsPerExecution,
        bytes: execution.bytes,
        trace,
        rawTrace: execution.trace,
      });

      if (conversationId) await linkExecutionToSession(conversationId, execution.executionId);
    }

    await recordIngestRun({
      kind: 'fidelity',
      startedAt,
      ok: true,
      apiCalls: budget.calls,
      rateLimited: budget.rateLimited,
      executionsDiscovered: executionIds.length,
      executionsRetrieved: retrieved,
      executionsNoHistory: noHistory,
      apiCallsPerExecution: outcome.apiCallsPerExecution,
      detail: {
        conversationsAsked: conversationIds.length,
        jobs: outcome.jobs,
        jobApiCalls: outcome.jobApiCalls,
        byPath: budget.byPath,
      },
    });

    return {
      ok: true,
      apiCalls: budget.calls,
      summary: {
        discovered: executionIds.length,
        retrieved,
        noHistory,
        apiCallsPerExecution: outcome.apiCallsPerExecution.toFixed(3),
      },
    };
  } catch (err) {
    const message = (err as Error)?.message ?? 'unknown';
    logger.error('ingest.fidelity.failed', { message });
    await recordIngestRun({
      kind: 'fidelity',
      startedAt,
      ok: false,
      apiCalls: budget.calls,
      rateLimited: budget.rateLimited,
      error: message,
    });
    return { ok: false, apiCalls: budget.calls, summary: { error: message } };
  }
}

/**
 * Conversations that triage has seen but fidelity has not resolved yet.
 *
 * NO_HISTORY is treated as settled, not pending, which is the difference between a worklist that
 * drains and one that grows forever: an execution that never terminated will answer 404 on every
 * future attempt, so re-asking costs API budget to learn nothing.
 */
async function pendingConversations(
  limit: number,
): Promise<{ rows: { conversation_id: string }[] }> {
  const { sql } = await import('@vercel/postgres');
  return sql<{ conversation_id: string }>`
    SELECT DISTINCT s.conversation_id
    FROM ava_sessions s
    WHERE s.conversation_id IS NOT NULL
      AND s.date_created > now() - interval '9 days'
      AND NOT EXISTS (
        SELECT 1 FROM ava_executions e
        WHERE e.conversation_id = s.conversation_id
          AND e.retrieval_status IN ('ARCHIVED', 'NO_HISTORY')
      )
    ORDER BY s.conversation_id
    LIMIT ${limit}
  `;
}
