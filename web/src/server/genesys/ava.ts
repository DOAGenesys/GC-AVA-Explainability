import 'server-only';

import { getServerConfig } from '../config';
import { logger } from '../logger';
import { genesysRequest, type ApiBudget, type Identity } from './http';

/**
 * The AVA observability surface, and the reasoning behind which endpoint is used for what.
 *
 * There are two sources, and they are not interchangeable:
 *
 *   1. **Execution history via the Jobs API** is the only source of AVA internals - the ordered
 *      action calls, each data action's inputs and outputs, the chosen output path and its reason.
 *      It is batchable: 10 execution ids per job, 2 API calls per job, and the content itself is
 *      served from a download host that does not consume API budget. Measured, not assumed: 10 ids
 *      are accepted and 11 are rejected with a bare 422.
 *   2. **Bot flow sessions** give a classified outcome per session in one call per flow. This is
 *      the cheapest AVA signal that exists.
 * Bot flow sessions matter for a reason that is easy to miss: they see conversations that
 * execution history cannot. An execution that never reaches its flow's exit produces no history
 * at all, and the Jobs API answers 404 for it permanently.
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
  /**
   * Read from both shapes on purpose. This endpoint nests `channel` and `flow`, so nesting is the
   * house style, but the analytics dimensions for the same data expose `conversationId` flat. A
   * null here is not cosmetic: execution discovery keys entirely off the conversation id, so
   * reading only one of the two shapes silently costs every execution trace.
   */
  conversation?: { id?: string };
  conversationId?: string;
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
  let observedFields: string[] | null = null;
  let missingConversationId = 0;

  for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
    const res = await genesysRequest<{ entities?: SessionEntity[]; pageCount?: number }>({
      path: `/api/v2/analytics/botflows/${flowId}/sessions`,
      query: { interval: intervalParam(interval), pageSize: 100, pageNumber },
      identity,
      budget,
      expectedStatuses: [404],
    });
    if (!res.ok || !res.data) break;

    const entities = res.data.entities ?? [];
    if (entities[0] && observedFields === null) observedFields = Object.keys(entities[0]);

    for (const entity of entities) {
      if (!entity.id) continue;
      const conversationId = entity.conversation?.id ?? entity.conversationId ?? null;
      if (conversationId === null) missingConversationId += 1;

      sessions.push({
        sessionId: entity.id,
        flowId: entity.flow?.id ?? flowId,
        conversationId,
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

  // A historical session without a conversation id can never be linked to an execution trace, so
  // this is reported explicitly.
  if (missingConversationId > 0) {
    logger.warn('ava.sessions.missing_conversation_id', {
      flowId,
      missing: missingConversationId,
      total: sessions.length,
      observedFields,
    });
  }

  return sessions;
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
      entities?: {
        id?: string;
        failed?: boolean;
        statusCode?: string | number;
        downloadUri?: string;
      }[];
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
          statusCode: entity.statusCode == null ? null : String(entity.statusCode),
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

export function isConfirmedNoHistory(failed: boolean, statusCode: unknown): boolean {
  return failed && String(statusCode) === '404';
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

    if (!outcome) {
      executions.push({
        executionId,
        trace: null,
        bytes: 0,
        noHistory: false,
        statusCode: null,
      });
      continue;
    }

    const confirmedAbsent = isConfirmedNoHistory(outcome.failed, outcome.statusCode);
    if (confirmedAbsent) {
      executions.push({
        executionId,
        trace: null,
        bytes: 0,
        noHistory: true,
        statusCode: outcome.statusCode,
      });
      continue;
    }

    if (outcome.failed || !outcome.downloadUri) {
      executions.push({
        executionId,
        trace: null,
        bytes: 0,
        noHistory: false,
        statusCode: outcome.statusCode ?? 'rejected',
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
    agenticVirtualAgentId?: string;
    agenticVirtualAgentName?: string;
    [key: string]: unknown;
  };
  outputData?: {
    successOutputs?: { outputName?: string; value?: unknown }[];
    failureOutputs?: { outputName?: string; value?: unknown }[];
    /** Why the AVA handed control back, e.g. `TriggeredByUser`. */
    exitReason?: string;
  };
  /**
   * The AVA's own turn-by-turn execution, present only on `actionCallAgenticVirtualAgent`.
   *
   * This is where an AVA's tool calls live. The flow sees one action; everything the model decided
   * is nested in here.
   */
  execution?: TraceAvaTurn[];
  variables?: { variableName?: string; value?: unknown }[];
  outputVariables?: { variableName?: string; value?: unknown }[];
  flowExitReason?: string;
  error?: unknown;
  warning?: unknown;
}

/**
 * One tool the AVA invoked, as recorded inside an AVA action.
 *
 * An AVA's tools are Data Actions, so `dataAction` carries the same substance as a flow-level
 * `actionCallData` item - but shaped differently: `input` is already an object rather than
 * name/value pairs, and `successOutput` is the response as a JSON *string*.
 */
export interface TraceAvaTool {
  toolName?: string;
  toolId?: string;
  toolExecutionId?: string;
  startDateTime?: string;
  endDateTime?: string;
  dataAction?: {
    id?: string;
    input?: Record<string, unknown>;
    successOutput?: string;
    failureOutput?: string;
    isSecure?: boolean;
  };
}

/** One conversational turn inside an AVA action: who said what, and which tools it ran. */
export interface TraceAvaTurn {
  turn?: {
    fromParticipant?: { dateTime?: string; digital?: { dateTime?: string; text?: string } };
    toParticipant?: {
      dateTime?: string;
      digitalItems?: { text?: string; promptIsNull?: boolean }[];
    };
    tools?: TraceAvaTool[];
  };
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
  /**
   * Call order within the execution, and the archive's key alongside the execution id.
   *
   * This counts tool calls rather than timeline items, because one AVA action hosts many calls and
   * they would otherwise collide on a shared item index.
   */
  ordinal: number;
  /** The timeline item this call was made from, so the UI can group calls under their host. */
  parentOrdinal: number;
  /** Whether the action was selected by the AVA or authored directly in the flow. */
  source: 'ava' | 'flow';
  toolName: string;
  category: string | null;
  at: string | null;
  endAt: string | null;
  toolExecutionId: string | null;
  /** Internal AVA turn index. Present only for model-selected tools. */
  avaTurnIndex: number | null;
  succeeded: boolean;
  outputPathReason: string | null;
  outputPathReasonValue: string | null;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  latencyMs: number | null;
}

/** A conversational event inside an AVA action, retaining the tool-to-turn relationship. */
export interface AvaConversationTurn {
  ordinal: number;
  parentOrdinal: number;
  turnIndex: number;
  customerText: string | null;
  customerAt: string | null;
  avaText: string | null;
  avaAt: string | null;
  toolOrdinals: number[];
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
  avaTurns: AvaConversationTurn[];
  botStates: { ordinal: number; stateName: string; at: string | null }[];
  errorCount: number;
  warningCount: number;
  flowExitReason: string | null;
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

/**
 * Recover the Data Action category from its id, which is formatted `{category}_-_{guid}`.
 *
 * The nested form carries no `categoryName`, and the category is worth keeping because it is how a
 * custom action is told apart from an integration's own.
 */
function categoryFromDataActionId(id: string | undefined): string | null {
  if (!id) return null;
  const at = id.indexOf('_-_');
  return at > 0 ? id.slice(0, at) : null;
}

/**
 * Read a nested tool's output, which arrives as a JSON string rather than as a value.
 *
 * A non-JSON body is kept verbatim under `output` rather than discarded: a tool that returned
 * plain text is still evidence, and losing it would misreport the call as having returned nothing.
 */
function parseToolOutput(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { output: parsed };
  } catch {
    return { output: raw };
  }
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
  const avaTurns: AvaConversationTurn[] = [];
  const botStates: { ordinal: number; stateName: string; at: string | null }[] = [];
  let errorCount = 0;
  let warningCount = 0;

  items.forEach((item, index) => {
    if (item.payload.error) errorCount += 1;
    if (item.payload.warning) warningCount += 1;

    if (item.kind === 'startedBotState' && item.payload.stateName) {
      botStates.push({ ordinal: item.ordinal, stateName: item.payload.stateName, at: item.at });
    }

    // An AVA action hosts its tool calls internally, one `tools` array per conversational turn.
    // Reading only the top level reports zero tool calls for precisely the executions this archive
    // exists to explain, because a flow that delegates to an AVA has no `actionCallData` items.
    if (item.kind === 'actionCallAgenticVirtualAgent') {
      (item.payload.execution ?? []).forEach((wrapper, turnIndex) => {
        const turn = wrapper.turn;
        if (!turn) return;

        const toolOrdinals: number[] = [];
        for (const tool of turn.tools ?? []) {
          const action = tool.dataAction;
          // There is no status field. A call that came back on the success path has a
          // `successOutput`, and its absence is what marks the failure path.
          const succeeded = typeof action?.successOutput === 'string';
          const ordinal = toolCalls.length;

          toolCalls.push({
            ordinal,
            parentOrdinal: item.ordinal,
            source: 'ava',
            toolName: tool.toolName ?? '(unnamed tool)',
            category: categoryFromDataActionId(action?.id),
            at: tool.startDateTime ?? item.at,
            endAt: tool.endDateTime ?? null,
            toolExecutionId: tool.toolExecutionId ?? null,
            avaTurnIndex: turnIndex,
            succeeded,
            outputPathReason: null,
            outputPathReasonValue: null,
            inputs: action?.input ?? {},
            outputs: parseToolOutput(succeeded ? action?.successOutput : action?.failureOutput),
            // Each nested call carries its own start and end, so this latency is measured rather
            // than inferred from whatever the flow happened to do next.
            latencyMs: msBetween(tool.startDateTime, tool.endDateTime),
          });
          toolOrdinals.push(ordinal);
        }

        const customerText = turn.fromParticipant?.digital?.text?.trim() || null;
        const avaText =
          turn.toParticipant?.digitalItems
            ?.map((part) => part.text?.trim())
            .filter((part): part is string => Boolean(part))
            .join('\n') || null;

        avaTurns.push({
          ordinal: avaTurns.length,
          parentOrdinal: item.ordinal,
          turnIndex,
          customerText,
          customerAt:
            turn.fromParticipant?.digital?.dateTime ?? turn.fromParticipant?.dateTime ?? null,
          avaText,
          avaAt: turn.toParticipant?.dateTime ?? null,
          toolOrdinals,
        });
      });
      return;
    }

    if (item.kind !== 'actionCallData') return;

    const successOutputs = item.payload.outputData?.successOutputs ?? [];
    const failureOutputs = item.payload.outputData?.failureOutputs ?? [];
    const succeeded = successOutputs.length > 0 && failureOutputs.length === 0;

    toolCalls.push({
      ordinal: toolCalls.length,
      parentOrdinal: item.ordinal,
      source: 'flow',
      toolName: item.payload.actionName ?? item.payload.inputData?.actionName ?? '(unnamed action)',
      category: item.payload.inputData?.categoryName ?? null,
      at: item.at,
      endAt: items[index + 1]?.at ?? flow.endDateTime ?? null,
      toolExecutionId: item.payload.executionId ?? null,
      avaTurnIndex: null,
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
    avaTurns,
    botStates,
    errorCount,
    warningCount,
    flowExitReason:
      [...items].reverse().find((item) => item.kind === 'endedFlow')?.payload.flowExitReason ??
      null,
  };
}
