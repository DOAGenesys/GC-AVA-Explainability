import 'server-only';

import { getServerConfig } from '../config';
import { logger } from '../logger';
import { genesysRequest, type ApiBudget, type Identity } from './http';

/**
 * The AVA observability surface, and the reasoning behind which endpoint is used for what.
 *
 * There are three sources, and they are not interchangeable:
 *
 *   1. **Execution history via the Jobs API** is the only source of AVA internals - the ordered
 *      action calls, each data action's inputs and outputs, the chosen output path and its reason.
 *      It is batchable: 10 execution ids per job, 2 API calls per job, and the content itself is
 *      served from a download host that does not consume API budget. Measured, not assumed: 10 ids
 *      are accepted and 11 are rejected with a bare 422.
 *   2. **Bot flow sessions** give a classified outcome per session in one call per flow. This is
 *      the cheapest AVA signal that exists.
 *   3. **Bot flow reporting turns** give the per-turn transcript in one call per flow, with a
 *      10-day retention window.
 *
 * Sources 2 and 3 matter for a reason that is easy to miss: **they see conversations that
 * execution history cannot**. An execution that never reaches its flow's exit produces no history
 * at all, and the Jobs API answers 404 for it permanently. On the flow this was validated against,
 * that was 6 of 7 sessions. Any dashboard built only on execution history would silently under-
 * report by that margin, so the two analytics endpoints are the coverage spine and the Jobs API is
 * the fidelity layer on top.
 *
 * Nothing here calls a per-item endpoint. `GET /flows/instances/{id}` is deliberately unused: it
 * creates a job internally, so it costs the same as a job while carrying a single execution.
 */

// The measured Jobs acceptance ceiling. Raising this does not increase throughput, it just forces
// the bisect path and costs more calls.
const JOBS_CEILING = 10;
const JOB_TERMINAL_STATES = new Set(['Success', 'Failed']);

export interface Interval {
  startIso: string;
  endIso: string;
}

export function intervalParam(interval: Interval): string {
  return `${interval.startIso}/${interval.endIso}`;
}

export function lookbackInterval(minutes: number): Interval {
  const end = new Date();
  const start = new Date(end.getTime() - minutes * 60_000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

// --------------------------------------------------------------------------- flow registry

export interface AvaFlow {
  flowId: string;
  name: string;
  flowType: string;
  divisionId: string | null;
  avaEnabled: boolean;
  publishedVersion: string | null;
}

interface FlowEntity {
  id?: string;
  name?: string;
  type?: string;
  division?: { id?: string };
  agenticVirtualAgentEnabled?: boolean;
  publishedVersion?: { version?: string; agenticVirtualAgentEnabled?: boolean };
}

/**
 * List bot flows and mark which ones are AVA-enabled.
 *
 * The flag is read from both the flow and its published version, because they are not always in
 * step, and it is refreshed on a schedule rather than cached indefinitely: during validation this
 * flag was observed changing within a single day as flows were published, and a registry that
 * drifts silently drops live AVA flows out of ingestion.
 */
export async function listAvaFlows(identity: Identity, budget: ApiBudget): Promise<AvaFlow[]> {
  const flows: AvaFlow[] = [];

  for (const type of ['bot', 'digitalbot'] as const) {
    for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
      const res = await genesysRequest<{ entities?: FlowEntity[]; pageCount?: number }>({
        path: '/api/v2/flows',
        query: { type, pageSize: 100, pageNumber },
        identity,
        budget,
      });
      if (!res.ok || !res.data) break;

      for (const entity of res.data.entities ?? []) {
        if (!entity.id) continue;
        flows.push({
          flowId: entity.id,
          name: entity.name ?? '(unnamed)',
          flowType: entity.type ?? type,
          divisionId: entity.division?.id ?? null,
          avaEnabled: Boolean(
            entity.agenticVirtualAgentEnabled ??
            entity.publishedVersion?.agenticVirtualAgentEnabled,
          ),
          publishedVersion: entity.publishedVersion?.version ?? null,
        });
      }

      if (pageNumber >= (res.data.pageCount ?? 1)) break;
    }
  }

  return flows;
}

// --------------------------------------------------------------------------- sessions

export interface BotFlowSession {
  sessionId: string;
  flowId: string;
  conversationId: string | null;
  channelName: string | null;
  language: string | null;
  endLanguage: string | null;
  botResult: string | null;
  botResultCategory: string | null;
  dateCreated: string | null;
  dateCompleted: string | null;
}

interface SessionEntity {
  id?: string;
  flow?: { id?: string };
  conversation?: { id?: string };
  channel?: { name?: string };
  language?: string;
  endLanguage?: string;
  botResult?: string;
  botResultCategory?: string;
  dateCreated?: string;
  dateCompleted?: string;
}

/** One call per flow returns every session in the window with its classified outcome. */
export async function getBotFlowSessions(
  flowId: string,
  interval: Interval,
  identity: Identity,
  budget: ApiBudget,
): Promise<BotFlowSession[]> {
  const sessions: BotFlowSession[] = [];

  for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
    const res = await genesysRequest<{ entities?: SessionEntity[]; pageCount?: number }>({
      path: `/api/v2/analytics/botflows/${flowId}/sessions`,
      query: { interval: intervalParam(interval), pageSize: 100, pageNumber },
      identity,
      budget,
      expectedStatuses: [404],
    });
    if (!res.ok || !res.data) break;

    for (const entity of res.data.entities ?? []) {
      if (!entity.id) continue;
      sessions.push({
        sessionId: entity.id,
        flowId: entity.flow?.id ?? flowId,
        conversationId: entity.conversation?.id ?? null,
        channelName: entity.channel?.name ?? null,
        language: entity.language ?? null,
        endLanguage: entity.endLanguage ?? null,
        botResult: entity.botResult ?? null,
        botResultCategory: entity.botResultCategory ?? null,
        dateCreated: entity.dateCreated ?? null,
        dateCompleted: entity.dateCompleted ?? null,
      });
    }

    if (pageNumber >= (res.data.pageCount ?? 1)) break;
  }

  return sessions;
}

// --------------------------------------------------------------------------- reporting turns

export interface ReportingTurn {
  turnId: string;
  sessionId: string | null;
  flowId: string;
  conversationId: string | null;
  sequence: number | null;
  askAction: string | null;
  askActionResult: string | null;
  userInput: unknown;
  botPrompts: unknown;
  turnStart: string | null;
  turnEnd: string | null;
  /**
   * Whatever the platform returned that is not modelled above. The turn-level metadata fields for
   * tool calls, knowledge and guardrails land in this endpoint on 31 Aug 2026; keeping the raw
   * entity means those appear in the archive the day they ship, without a schema migration and
   * without a gap in the 10-day-retention data that would otherwise be lost forever.
   */
  raw: unknown;
}

export interface TurnEntity {
  id?: string;
  sessionId?: string;
  botFlowId?: string;
  conversation?: { id?: string };
  sequenceNumber?: number;
  askAction?: string;
  askActionResult?: string;
  userInput?: unknown;
  botPrompts?: unknown;
  turnStartTimestamp?: string;
  turnEndTimestamp?: string;
}

/**
 * Stable primary key for a turn.
 *
 * A ReportingTurn carries no id of its own, so one is derived from the natural key: turns are
 * numbered within a session. It has to be deterministic, because the archive is maintained by
 * upsert and a fresh key on every pass would duplicate the whole transcript each run.
 */
export function turnKey(entity: TurnEntity): string | null {
  if (entity.id) return entity.id;
  const owner = entity.sessionId ?? entity.conversation?.id;
  if (!owner || entity.sequenceNumber === undefined) return null;
  return `${owner}:${entity.sequenceNumber}`;
}

/** Pull the opaque `after` cursor out of the nextUri the platform hands back. */
export function cursorFromNextUri(nextUri: string | undefined): string | null {
  if (!nextUri) return null;
  try {
    // nextUri is relative, so it needs a base to parse against; the base is then discarded.
    return new URL(nextUri, 'https://api.invalid').searchParams.get('after');
  } catch {
    return null;
  }
}

/**
 * The per-turn transcript for a flow.
 *
 * Note the absence of an interval: this endpoint has no date filter and always returns whatever
 * utterance history is still within the platform's 10-day TTL. The ingestion lookback therefore
 * has no effect here, and the cost of this call grows with retained turn volume rather than with
 * the schedule - worth watching once a flow sustains thousands of turns per window.
 */
export async function getReportingTurns(
  flowId: string,
  identity: Identity,
  budget: ApiBudget,
): Promise<ReportingTurn[]> {
  const turns: ReportingTurn[] = [];
  let after: string | null = null;
  let unkeyable = 0;

  for (let page = 0; page < 30; page += 1) {
    const res = await genesysRequest<{ entities?: TurnEntity[]; nextUri?: string }>({
      path: `/api/v2/analytics/botflows/${flowId}/reportingturns`,
      query: { pageSize: 100, ...(after ? { after } : {}) },
      identity,
      budget,
      expectedStatuses: [404],
    });

    if (!res.ok || !res.data) {
      // Never fail silently here: turn data is the only durable copy of a 10-day retention window,
      // so a swallowed error is permanent transcript loss.
      logger.warn('ava.reportingturns.request_failed', { flowId, page, status: res.status });
      break;
    }

    const entities = res.data.entities ?? [];
    for (const entity of entities) {
      const turnId = turnKey(entity);
      if (!turnId) {
        unkeyable += 1;
        continue;
      }
      turns.push({
        turnId,
        sessionId: entity.sessionId ?? null,
        flowId: entity.botFlowId ?? flowId,
        conversationId: entity.conversation?.id ?? null,
        sequence: entity.sequenceNumber ?? null,
        askAction: entity.askAction ?? null,
        askActionResult: entity.askActionResult ?? null,
        userInput: entity.userInput ?? null,
        botPrompts: entity.botPrompts ?? null,
        turnStart: entity.turnStartTimestamp ?? null,
        turnEnd: entity.turnEndTimestamp ?? null,
        raw: entity,
      });
    }

    const next = cursorFromNextUri(res.data.nextUri);
    if (!next || entities.length === 0) break;
    after = next;
  }

  if (unkeyable > 0) {
    logger.warn('ava.reportingturns.unkeyable_entities', { flowId, unkeyable, kept: turns.length });
  }

  return turns;
}

// --------------------------------------------------------------------------- execution discovery

/**
 * Resolve conversation ids to flow execution ids.
 *
 * This is the discovery step, and it exists because the Jobs API cannot list - it only answers
 * "give me these ids". `ConversationId` is used because it is one of the criteria this org's query
 * capabilities actually permit, and because the triage pass has already produced conversation ids
 * for free. No temporal criterion is available, so the window is expressed by which conversations
 * are asked about rather than by a date filter.
 */
export async function findExecutionIds(
  conversationIds: string[],
  identity: Identity,
  budget: ApiBudget,
): Promise<Map<string, { executionId: string; flowId: string; flowVersion: string | null }[]>> {
  const byConversation = new Map<
    string,
    { executionId: string; flowId: string; flowVersion: string | null }[]
  >();
  if (conversationIds.length === 0) return byConversation;

  // The criteria value list is the batching mechanism here, so discovery for a whole cron window
  // costs a handful of calls rather than one per conversation.
  const CHUNK = 50;
  for (let start = 0; start < conversationIds.length; start += CHUNK) {
    const chunk = conversationIds.slice(start, start + CHUNK);
    const res = await genesysRequest<{
      entities?: {
        id?: string;
        flowId?: string;
        flowVersion?: string;
        conversationId?: string;
      }[];
    }>({
      path: '/api/v2/flows/instances/query',
      method: 'POST',
      query: { pageSize: 200 },
      body: {
        criteria: [{ criteriaKey: 'ConversationId', values: chunk, operator: 'EQ' }],
      },
      identity,
      budget,
      expectedStatuses: [404, 422],
    });

    if (!res.ok || !res.data) {
      logger.warn('ava.discovery.query_failed', { status: res.status, chunk: chunk.length });
      continue;
    }

    for (const entity of res.data.entities ?? []) {
      if (!entity.id || !entity.conversationId) continue;
      const list = byConversation.get(entity.conversationId) ?? [];
      list.push({
        executionId: entity.id,
        flowId: entity.flowId ?? '',
        flowVersion: entity.flowVersion ?? null,
      });
      byConversation.set(entity.conversationId, list);
    }
  }

  return byConversation;
}

// --------------------------------------------------------------------------- execution history

export interface JobEntityResult {
  executionId: string;
  failed: boolean;
  statusCode: string | null;
  downloadUri: string | null;
}

export interface JobMeta {
  size: number;
  accepted: boolean;
  jobId?: string;
  jobState?: string;
  entities?: number;
  apiCalls: number;
  error?: string;
}

async function submitOneJob(
  ids: string[],
  identity: Identity,
  budget: ApiBudget,
): Promise<{ results: Map<string, JobEntityResult>; meta: JobMeta }> {
  const created = await genesysRequest<{ id?: string }>({
    path: '/api/v2/flows/instances/jobs',
    method: 'POST',
    body: { ids },
    identity,
    budget,
    expectedStatuses: [422],
  });

  if (!created.ok || !created.data?.id) {
    return {
      results: new Map(),
      meta: {
        size: ids.length,
        accepted: false,
        apiCalls: 1,
        error: `submit returned ${created.status}`,
      },
    };
  }

  const jobId = created.data.id;
  let apiCalls = 1;
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const poll = await genesysRequest<{
      jobState?: string;
      entities?: { id?: string; failed?: boolean; statusCode?: string; downloadUri?: string }[];
    }>({ path: `/api/v2/flows/instances/jobs/${jobId}`, identity, budget });
    apiCalls += 1;

    if (!poll.ok || !poll.data) {
      return {
        results: new Map(),
        meta: { size: ids.length, accepted: true, jobId, apiCalls, error: 'poll failed' },
      };
    }

    const state = poll.data.jobState;
    if (state && JOB_TERMINAL_STATES.has(state)) {
      const results = new Map<string, JobEntityResult>();
      for (const entity of poll.data.entities ?? []) {
        if (!entity.id) continue;
        results.set(entity.id, {
          executionId: entity.id,
          // An execution the platform holds nothing for still comes back as an entity, inside a
          // job that reached Success, flagged failed with statusCode 404. Counting entities rather
          // than unfailed entities is how an empty archive comes to look like a complete one.
          failed: Boolean(entity.failed),
          statusCode: entity.statusCode ?? null,
          downloadUri: entity.downloadUri ?? null,
        });
      }
      return {
        results,
        meta: {
          size: ids.length,
          accepted: true,
          jobId,
          jobState: state,
          entities: results.size,
          apiCalls,
        },
      };
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  return {
    results: new Map(),
    meta: { size: ids.length, accepted: true, jobId, apiCalls, error: 'job timed out' },
  };
}

/**
 * Submit ids, halving on wholesale rejection until the unacceptable ones are isolated.
 *
 * A rejected batch returns a bare 422 naming no id, so treating rejection as "none of these are
 * retrievable" is indistinguishable from catastrophic data loss - during validation that exact
 * mistake produced a "0 of 15 retained" reading against a platform that held all 15.
 */
async function submitBisecting(
  ids: string[],
  identity: Identity,
  budget: ApiBudget,
  meta: JobMeta[],
): Promise<Map<string, JobEntityResult>> {
  if (ids.length === 0) return new Map();

  const { results, meta: info } = await submitOneJob(ids, identity, budget);
  meta.push(info);

  if (info.accepted && !info.error) return results;

  if (ids.length === 1) {
    const only = ids[0]!;
    return new Map([
      [only, { executionId: only, failed: true, statusCode: 'rejected', downloadUri: null }],
    ]);
  }

  const middle = Math.floor(ids.length / 2);
  const left = await submitBisecting(ids.slice(0, middle), identity, budget, meta);
  const right = await submitBisecting(ids.slice(middle), identity, budget, meta);
  return new Map([...left, ...right]);
}

export interface RetrievedExecution {
  executionId: string;
  trace: FlowExecutionTrace | null;
  bytes: number;
  noHistory: boolean;
  statusCode: string | null;
}

export interface RetrievalOutcome {
  executions: RetrievedExecution[];
  jobs: JobMeta[];
  jobApiCalls: number;
  apiCallsPerExecution: number;
}

/**
 * Retrieve full execution history for a set of executions, batched at the measured ceiling.
 *
 * The content downloads are not counted into the API budget on purpose: they are served from a
 * separate download host (`api-downloads.<region>`), not the Platform API, so they do not consume
 * the API rate allowance. That distinction is the reason this whole approach scales.
 */
export async function retrieveExecutionHistories(
  executionIds: string[],
  identity: Identity,
  budget: ApiBudget,
): Promise<RetrievalOutcome> {
  const unique = [...new Set(executionIds)];
  const ceiling = Math.min(getServerConfig().jobsMaxIdsPerRequest, JOBS_CEILING);
  const meta: JobMeta[] = [];
  const resolved = new Map<string, JobEntityResult>();

  for (let start = 0; start < unique.length; start += ceiling) {
    const batch = await submitBisecting(
      unique.slice(start, start + ceiling),
      identity,
      budget,
      meta,
    );
    for (const [id, value] of batch) resolved.set(id, value);
  }

  const jobApiCalls = meta.reduce((sum, m) => sum + m.apiCalls, 0);
  const executions: RetrievedExecution[] = [];

  for (const executionId of unique) {
    const outcome = resolved.get(executionId);

    if (!outcome || outcome.failed || !outcome.downloadUri) {
      executions.push({
        executionId,
        trace: null,
        bytes: 0,
        noHistory: true,
        statusCode: outcome?.statusCode ?? null,
      });
      continue;
    }

    try {
      // No Authorization header: the URI is pre-signed and points at a third-party download host.
      const res = await fetch(outcome.downloadUri, { cache: 'no-store' });
      if (!res.ok) throw new Error(`download status ${res.status}`);
      const text = await res.text();
      executions.push({
        executionId,
        trace: JSON.parse(text) as FlowExecutionTrace,
        bytes: text.length,
        noHistory: false,
        statusCode: outcome.statusCode,
      });
    } catch (err) {
      logger.warn('ava.history.download_failed', {
        executionId,
        message: (err as Error)?.message,
      });
      executions.push({
        executionId,
        trace: null,
        bytes: 0,
        noHistory: false,
        statusCode: outcome.statusCode,
      });
    }
  }

  return {
    executions,
    jobs: meta,
    jobApiCalls,
    apiCallsPerExecution: unique.length > 0 ? jobApiCalls / unique.length : 0,
  };
}

// --------------------------------------------------------------------------- trace parsing

/**
 * The execution history document, as the platform actually returns it.
 *
 * `flow.execution` is a list of single-key objects where the key names the item type
 * (`startedFlow`, `startedBotState`, `actionCallData`, `actionWait`, ...). There is no discriminant
 * field, so the item type has to be recovered from the key.
 */
export interface FlowExecutionTrace {
  flow?: {
    executionId?: string;
    flowId?: string;
    flowName?: string;
    flowType?: string;
    flowVersion?: string;
    conversationId?: string;
    alternateExecutionId?: string;
    division?: { id?: string };
    startDateTime?: string;
    endDateTime?: string;
    isTruncated?: boolean;
    isSecure?: boolean;
    flowIsDebug?: boolean;
    executionInfo?: { logLevel?: string };
    execution?: Record<string, TraceItemPayload>[];
  };
}

export interface TraceItemPayload {
  dateTime?: string;
  executionId?: string;
  trackingId?: number;
  actionId?: string;
  actionName?: string;
  stateId?: string;
  stateName?: string;
  languageTag?: string;
  outputPathId?: string;
  outputPathInfo?: { reason?: string; reasonValue?: string };
  inputData?: {
    actionId?: string;
    actionName?: string;
    categoryName?: string;
    inputs?: { inputName?: string; value?: unknown }[];
    [key: string]: unknown;
  };
  outputData?: {
    successOutputs?: { outputName?: string; value?: unknown }[];
    failureOutputs?: { outputName?: string; value?: unknown }[];
  };
  variables?: { variableName?: string; value?: unknown }[];
  outputVariables?: { variableName?: string; value?: unknown }[];
  error?: unknown;
  warning?: unknown;
}

export interface NormalizedTraceItem {
  ordinal: number;
  kind: string;
  at: string | null;
  label: string | null;
  trackingId: number | null;
  /** Milliseconds since the previous item, which is the only latency the document permits. */
  sincePreviousMs: number | null;
  payload: TraceItemPayload;
}

export interface ToolCall {
  ordinal: number;
  toolName: string;
  category: string | null;
  at: string | null;
  succeeded: boolean;
  outputPathReason: string | null;
  outputPathReasonValue: string | null;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  latencyMs: number | null;
}

export interface ParsedTrace {
  executionId: string | null;
  flowId: string | null;
  flowName: string | null;
  flowType: string | null;
  flowVersion: string | null;
  conversationId: string | null;
  startDateTime: string | null;
  endDateTime: string | null;
  durationMs: number | null;
  truncated: boolean;
  secure: boolean;
  debug: boolean;
  items: NormalizedTraceItem[];
  toolCalls: ToolCall[];
  botStates: { ordinal: number; stateName: string; at: string | null }[];
  errorCount: number;
  warningCount: number;
}

function pairsToRecord(
  pairs:
    | { inputName?: string; outputName?: string; variableName?: string; value?: unknown }[]
    | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs ?? []) {
    const name = pair.inputName ?? pair.outputName ?? pair.variableName;
    if (name) out[name] = pair.value ?? null;
  }
  return out;
}

function msBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const from = Date.parse(a);
  const to = Date.parse(b);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return to - from;
}

/**
 * Flatten an execution history document into a timeline plus the tool calls made along the way.
 *
 * Tool calls are `actionCallData` items: an AVA's tools are Data Actions, so this is where the
 * inputs the model chose and the outputs it received are recorded. Success is taken from which
 * output list is populated rather than from a status field, because the document has no such
 * field - a call that produced `failureOutputs` took the failure path regardless of HTTP status.
 */
export function parseTrace(doc: FlowExecutionTrace): ParsedTrace {
  const flow = doc.flow ?? {};
  const raw = flow.execution ?? [];

  const items: NormalizedTraceItem[] = [];
  let previousAt: string | null = null;

  raw.forEach((wrapper, index) => {
    const entries = Object.entries(wrapper);
    for (const [kind, payload] of entries) {
      if (!payload || typeof payload !== 'object') continue;
      const at = payload.dateTime ?? null;
      items.push({
        ordinal: index,
        kind,
        at,
        label: payload.actionName ?? payload.stateName ?? null,
        trackingId: payload.trackingId ?? null,
        sincePreviousMs: msBetween(previousAt, at),
        payload,
      });
      if (at) previousAt = at;
    }
  });

  const toolCalls: ToolCall[] = [];
  const botStates: { ordinal: number; stateName: string; at: string | null }[] = [];
  let errorCount = 0;
  let warningCount = 0;

  items.forEach((item, index) => {
    if (item.payload.error) errorCount += 1;
    if (item.payload.warning) warningCount += 1;

    if (item.kind === 'startedBotState' && item.payload.stateName) {
      botStates.push({ ordinal: item.ordinal, stateName: item.payload.stateName, at: item.at });
    }

    if (item.kind !== 'actionCallData') return;

    const successOutputs = item.payload.outputData?.successOutputs ?? [];
    const failureOutputs = item.payload.outputData?.failureOutputs ?? [];
    const succeeded = successOutputs.length > 0 && failureOutputs.length === 0;

    toolCalls.push({
      ordinal: item.ordinal,
      toolName: item.payload.actionName ?? item.payload.inputData?.actionName ?? '(unnamed action)',
      category: item.payload.inputData?.categoryName ?? null,
      at: item.at,
      succeeded,
      outputPathReason: item.payload.outputPathInfo?.reason ?? null,
      outputPathReasonValue: item.payload.outputPathInfo?.reasonValue ?? null,
      inputs: pairsToRecord(item.payload.inputData?.inputs),
      outputs: succeeded ? pairsToRecord(successOutputs) : pairsToRecord(failureOutputs),
      // The next item's timestamp is the only evidence of how long the call took.
      latencyMs: msBetween(item.at, items[index + 1]?.at ?? flow.endDateTime ?? null),
    });
  });

  return {
    executionId: flow.executionId ?? null,
    flowId: flow.flowId ?? null,
    flowName: flow.flowName ?? null,
    flowType: flow.flowType ?? null,
    flowVersion: flow.flowVersion ?? null,
    conversationId: flow.conversationId ?? null,
    startDateTime: flow.startDateTime ?? null,
    endDateTime: flow.endDateTime ?? null,
    durationMs: msBetween(flow.startDateTime, flow.endDateTime),
    truncated: Boolean(flow.isTruncated),
    secure: Boolean(flow.isSecure),
    debug: Boolean(flow.flowIsDebug),
    items,
    toolCalls,
    botStates,
    errorCount,
    warningCount,
  };
}
