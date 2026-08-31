import 'server-only';

import {
  assertDatabaseConfigured,
  claimExecutions,
  linkExecutionToSession,
  recordCaptureRun,
  upsertExecution,
} from '../db';
import {
  parseTrace,
  retrieveExecutionHistories,
  type JobMeta,
  type RetrievalOutcome,
} from '../genesys/ava';
import { newBudget, type Identity } from '../genesys/http';
import { logger } from '../logger';
import { dedupeCaptureTriples, type CaptureTriple } from './helpers';

export type CaptureExecutionStatus =
  'skipped_settled' | 'skipped_duplicate' | 'archived' | 'no_history' | 'download_failed';

export interface CaptureExecutionResult {
  executionId: string;
  status: CaptureExecutionStatus;
  jobsStatusCode: string | null;
  bytes?: number;
}

export interface CaptureMetrics {
  requested: number;
  deduped: number;
  skippedSettled: number;
  fetched: number;
  archived: number;
  noHistory: number;
  downloadFailed: number;
  apiCallsPerExecution: number | null;
  jobs: JobMeta[];
  jobApiCalls: number;
}

export interface CaptureResult {
  ok: boolean;
  apiCalls: number;
  results: CaptureExecutionResult[];
  metrics: CaptureMetrics;
}

const USER_IDENTITY: Identity = { kind: 'user' };

/**
 * Capture execution histories for event-supplied triples using the signed-in user's Genesys token.
 *
 * Settled rows (ARCHIVED or NO_HISTORY) are skipped without spending Jobs budget. Transient Jobs or
 * download failures are recorded as DOWNLOAD_FAILED so a later retry can succeed.
 */
export async function captureExecutions(triples: CaptureTriple[]): Promise<CaptureResult> {
  assertDatabaseConfigured();
  const startedAt = new Date();
  const budget = newBudget();

  const { unique, duplicateExecutionIds } = dedupeCaptureTriples(triples);
  const claimed = await claimExecutions(unique);

  const results: CaptureExecutionResult[] = [];
  for (const executionId of duplicateExecutionIds) {
    results.push({
      executionId,
      status: 'skipped_duplicate',
      jobsStatusCode: null,
    });
  }

  const toFetch: CaptureTriple[] = [];
  for (const triple of unique) {
    if (!claimed.has(triple.executionId)) {
      results.push({
        executionId: triple.executionId,
        status: 'skipped_settled',
        jobsStatusCode: null,
      });
    } else {
      toFetch.push(triple);
    }
  }

  let outcomeJobs: JobMeta[] = [];
  let jobApiCalls = 0;
  let apiCallsPerExecution: number | null = null;

  if (toFetch.length > 0) {
    const tripleByExecution = new Map(toFetch.map((triple) => [triple.executionId, triple]));
    let outcome: RetrievalOutcome;
    try {
      outcome = await retrieveExecutionHistories(
        toFetch.map((triple) => triple.executionId),
        USER_IDENTITY,
        budget,
      );
    } catch (cause) {
      await Promise.all(
        toFetch.map((event) =>
          upsertExecution({
            executionId: event.executionId,
            flowId: event.flowId,
            conversationId: event.conversationId,
            sessionId: null,
            retrievalStatus: 'DOWNLOAD_FAILED',
            jobsStatusCode: null,
            apiCallsPerExecution: null,
            bytes: 0,
            trace: null,
            rawTrace: null,
          }),
        ),
      );
      throw cause;
    }
    outcomeJobs = outcome.jobs;
    jobApiCalls = outcome.jobApiCalls;
    apiCallsPerExecution = outcome.apiCallsPerExecution;

    for (const execution of outcome.executions) {
      const event = tripleByExecution.get(execution.executionId);
      if (!event) continue;

      const trace = execution.trace ? parseTrace(execution.trace) : null;
      let status: CaptureExecutionStatus;
      if (execution.noHistory) status = 'no_history';
      else if (trace) status = 'archived';
      else status = 'download_failed';

      await upsertExecution({
        executionId: execution.executionId,
        flowId: trace?.flowId ?? event.flowId,
        conversationId: trace?.conversationId ?? event.conversationId,
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

      if (event.conversationId) {
        await linkExecutionToSession(event.conversationId, execution.executionId);
      }

      results.push({
        executionId: execution.executionId,
        status,
        jobsStatusCode: execution.statusCode,
        bytes: execution.bytes > 0 ? execution.bytes : undefined,
      });
    }
  }

  const archived = results.filter((row) => row.status === 'archived').length;
  const noHistory = results.filter((row) => row.status === 'no_history').length;
  const downloadFailed = results.filter((row) => row.status === 'download_failed').length;
  const skippedSettled = results.filter((row) => row.status === 'skipped_settled').length;

  const metrics: CaptureMetrics = {
    requested: triples.length,
    deduped: duplicateExecutionIds.length,
    skippedSettled,
    fetched: toFetch.length,
    archived,
    noHistory,
    downloadFailed,
    apiCallsPerExecution,
    jobs: outcomeJobs,
    jobApiCalls,
  };

  try {
    await recordCaptureRun({
      kind: 'capture',
      startedAt,
      ok: true,
      apiCalls: budget.calls,
      rateLimited: budget.rateLimited,
      executionsDiscovered: toFetch.length,
      executionsRetrieved: archived,
      executionsNoHistory: noHistory,
      apiCallsPerExecution,
      detail: {
        executionIds: unique.map((triple) => triple.executionId),
        requested: triples.length,
        deduped: duplicateExecutionIds.length,
        skippedSettled,
        downloadFailed,
        jobs: outcomeJobs,
        jobApiCalls,
        byPath: budget.byPath,
      },
    });
  } catch (err) {
    logger.error('capture.ingest_run.failed', { message: (err as Error)?.message });
    return { ok: false, apiCalls: budget.calls, results, metrics };
  }

  return { ok: true, apiCalls: budget.calls, results, metrics };
}
