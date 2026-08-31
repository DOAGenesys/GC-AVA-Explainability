import 'server-only';

import { createHash } from 'node:crypto';
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

  // A session without a conversation id can never gain an execution trace, so this is reported as a
  // warning rather than left to be inferred from an empty fidelity pass.
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

/**
 * A reporting turn as returned by the platform.
 *
 * The identifier fields are declared as alternatives rather than a single known name: this entity
 * has no documented `id`, and the analytics dimensions for the same data use `botSessionId` where
 * the session endpoint uses `sessionId`. The index signature keeps unrecognised fields accessible
 * so an unexpected shape degrades into a fallback key instead of dropping the turn.
 */
export interface TurnEntity {
  id?: string;
  turnId?: string;
  sessionId?: string;
  botSessionId?: string;
  session?: { id?: string };
  conversationId?: string;
  conversation?: { id?: string };
  // Declared as `number | string` because Genesys analytics routinely serialises counters as
  // strings, and a strict number check silently discards them.
  sequenceNumber?: number | string;
  turnNumber?: number | string;
  sequence?: number | string;
  botFlowId?: string;
  /** An object, not a string: `{ actionId, actionName, actionType, actionNumber }`. */
  askAction?: unknown;
  askActionResult?: string;
  /** A plain string - the utterance - not a structured input object. */
  userInput?: unknown;
  /** An array of prompt strings. */
  botPrompts?: unknown;
  /** The turn's own timing, and the only ordering the platform provides. */
  dateCreated?: string;
  dateCompleted?: string;
  turnStartTimestamp?: string;
  turnEndTimestamp?: string;
  [key: string]: unknown;
}

function firstString(entity: TurnEntity, keys: string[]): string | null {
  for (const key of keys) {
    const value = entity[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * First readable integer among `keys`, accepting a numeric string as well as a number.
 *
 * The coercion is the point: a turn counter arriving as `"3"` is still the ordering the transcript
 * needs, and rejecting it on type alone is what leaves a transcript unorderable.
 */
function firstNumber(entity: TurnEntity, keys: string[]): number | null {
  for (const key of keys) {
    const value = entity[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  }
  return null;
}

/**
 * Candidate field names for a turn's position and timing, in order of preference.
 *
 * `dateCreated` and `dateCompleted` are what this endpoint actually sends, confirmed against every
 * turn in a live archive. The other names are retained as fallbacks because the entity is
 * undocumented and has changed shape before.
 *
 * No sequence field was observed at all - the platform sends no turn number - so SEQUENCE_KEYS is
 * speculative and ordering rests on the timestamp.
 */
const SEQUENCE_KEYS = ['turnNumber', 'sequenceNumber', 'sequence', 'turnSequenceNumber'];
const TURN_START_KEYS = ['dateCreated', 'turnStartTimestamp', 'turnStart', 'startDate'];
const TURN_END_KEYS = ['dateCompleted', 'turnEndTimestamp', 'turnEnd', 'endDate'];

/**
 * A date field, preferring the known names but falling back to any plausibly-named key holding a
 * parseable timestamp.
 *
 * The fallback exists because this entity is undocumented and the transcript is unreadable without
 * some ordering: it is better to discover the field than to render turns in arbitrary order. The
 * key that matched is reported by the caller so the guess can be replaced with a certainty.
 */
function firstDate(
  entity: TurnEntity,
  keys: string[],
  pattern: RegExp,
): { key: string; value: string } | null {
  const parseable = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));

  for (const key of keys) {
    if (parseable(entity[key])) return { key, value: entity[key] as string };
  }
  for (const key of Object.keys(entity)) {
    if (pattern.test(key) && parseable(entity[key])) return { key, value: entity[key] as string };
  }
  return null;
}

/**
 * The ask action reduced to a label worth reading in a transcript.
 *
 * `askAction` is an object, and storing it whole put a JSON blob above every bot message. The name
 * is what identifies the step to an author; the full object stays in `raw`.
 */
function actionLabel(askAction: unknown): string | null {
  if (typeof askAction === 'string') return askAction || null;
  if (askAction === null || typeof askAction !== 'object') return null;

  const action = askAction as { actionName?: unknown; actionType?: unknown };
  if (typeof action.actionName === 'string' && action.actionName.length > 0) {
    return action.actionName;
  }
  return typeof action.actionType === 'string' && action.actionType.length > 0
    ? action.actionType
    : null;
}

/**
 * Deterministic last-resort key, derived from the turn's own content.
 *
 * Used only when no identifier can be found. Keys must be stable across passes or the archive would
 * gain a duplicate on every run, so the entity is serialised with sorted keys before hashing. The
 * trade-off is that a turn the platform later amends would land as a second row - acceptable,
 * because the alternative is discarding data that no longer exists upstream after 10 days.
 */
function contentKey(entity: TurnEntity): string {
  const canonical = JSON.stringify(entity, Object.keys(entity).sort());
  return `sha256:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

/**
 * Stable primary key for a turn.
 *
 * A ReportingTurn carries no id of its own, and no turn number either, so the key is the session
 * plus the instant the turn was created - the only pair the platform provides that is unique within
 * a session.
 *
 * Preferring this over hashing the turn's content is a correctness decision, not a cosmetic one. A
 * turn whose content is later amended upstream - an ask action moving from ConfirmationRequired to
 * SuccessCollection, say - keeps its identity here and updates in place, where a content hash would
 * treat it as a new turn and show the transcript twice.
 */
export function turnKey(entity: TurnEntity): string | null {
  const explicit = firstString(entity, ['id', 'turnId']);
  if (explicit) return explicit;

  const owner =
    firstString(entity, ['sessionId', 'botSessionId', 'conversationId']) ??
    (typeof entity.session?.id === 'string' ? entity.session.id : null) ??
    (typeof entity.conversation?.id === 'string' ? entity.conversation.id : null);
  if (owner === null) return null;

  const sequence = firstNumber(entity, SEQUENCE_KEYS);
  if (sequence !== null) return `${owner}:${sequence}`;

  const created = firstDate(entity, TURN_START_KEYS, /start|created/i);
  return created === null ? null : `${owner}:${created.value}`;
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
 * The per-turn transcript for a flow, bounded by the ingestion window.
 *
 * The window matters here beyond cost: without it the endpoint returns everything still inside the
 * platform's 10-day TTL on every pass, so the call would get steadily more expensive as a flow
 * accumulates turns rather than staying proportional to what is new.
 */
export async function getReportingTurns(
  flowId: string,
  interval: Interval,
  identity: Identity,
  budget: ApiBudget,
): Promise<ReportingTurn[]> {
  const turns: ReportingTurn[] = [];
  let after: string | null = null;
  let synthesised = 0;
  let unordered = 0;
  let resolvedStartKey: string | null = null;
  let observedFields: string[] | null = null;

  for (let page = 0; page < 30; page += 1) {
    const res = await genesysRequest<{ entities?: TurnEntity[]; nextUri?: string }>({
      path: `/api/v2/analytics/botflows/${flowId}/reportingturns`,
      query: {
        interval: intervalParam(interval),
        pageSize: 100,
        ...(after ? { after } : {}),
      },
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

    // Record the shape once, so an unrecognised entity is diagnosable from the logs without
    // needing a live probe. Field names only - the values are conversation content.
    if (entities[0] && observedFields === null) {
      observedFields = Object.keys(entities[0]);
    }

    for (const entity of entities) {
      const natural = turnKey(entity);
      if (natural === null) synthesised += 1;
      const turnId = natural ?? contentKey(entity);

      const start = firstDate(entity, TURN_START_KEYS, /start|created/i);
      const end = firstDate(entity, TURN_END_KEYS, /end|completed/i);
      const sequence = firstNumber(entity, SEQUENCE_KEYS);
      // Unordered means no ordering at all. A missing sequence is normal - the platform sends none -
      // so warning on that alone would fire on every run and mean nothing.
      if (sequence === null && start === null) unordered += 1;
      if (start) resolvedStartKey ??= start.key;

      turns.push({
        turnId,
        sessionId: firstString(entity, ['sessionId', 'botSessionId']),
        flowId: entity.botFlowId ?? flowId,
        conversationId: entity.conversation?.id ?? entity.conversationId ?? null,
        sequence,
        askAction: actionLabel(entity.askAction),
        askActionResult: entity.askActionResult ?? null,
        userInput: entity.userInput ?? null,
        botPrompts: entity.botPrompts ?? null,
        turnStart: start?.value ?? null,
        turnEnd: end?.value ?? null,
        raw: entity,
      });
    }

    const next = cursorFromNextUri(res.data.nextUri);
    if (!next || entities.length === 0) break;
    after = next;
  }

  // A synthesised key means no identifier field was recognised. The turn is still archived, but the
  // observed field names are logged so the natural key can be restored properly.
  if (synthesised > 0) {
    logger.warn('ava.reportingturns.synthesised_keys', {
      flowId,
      synthesised,
      kept: turns.length,
      observedFields,
    });
  }

  // Ordering is what makes a transcript readable, so losing it is reported explicitly rather than
  // showing up as a scrambled conversation with no corresponding signal.
  if (unordered > 0 && turns.length > 0) {
    logger.warn('ava.reportingturns.unordered', {
      flowId,
      unordered,
      kept: turns.length,
      resolvedStartKey,
      observedFields,
    });
  }

  return turns;
}

// --------------------------------------------------------------------------- execution discovery

/** Enough parallelism to drain a backlog within a cron invocation, well short of rate limiting. */
const DISCOVERY_CONCURRENCY = 4;

/**
 * Resolve conversation ids to flow execution ids.
 *
 * This is the discovery step, and it exists because the Jobs API cannot list - it only answers
 * "give me these ids". `ConversationId` is used because it is one of the criteria this org's query
 * capabilities actually permit, and because the triage pass has already produced conversation ids
 * for free. No temporal criterion is available, so the window is expressed by which conversations
 * are asked about rather than by a date filter.
 *
 * The criteria vocabulary is gated per org rather than by the OpenAPI enum, so what is permitted
 * comes from `GET /flows/instances/querycapabilities` and nothing else. Asking outside it fails
 * with 400 "Attempting to query with unallowed capabilities".
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

  // One conversation per request, and this is a constraint rather than a choice. A CriteriaItem
  // carries a single `value`, and an `or` group of several ConversationId predicates - the obvious
  // way to restore batching - is rejected with a bare 422 "input data is not valid". So the cost is
  // one call per conversation, and concurrency is what keeps a backlog inside the cron's wall clock.
  const queue = [...new Set(conversationIds)];
  let cursor = 0;
  let failed = 0;

  async function drain(): Promise<void> {
    while (cursor < queue.length) {
      const conversationId = queue[cursor]!;
      cursor += 1;

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
          // A CriteriaQuery: `query` holds CriteriaGroups, each with and/or/not arrays of
          // CriteriaItem {key, operator, value}. The plural `criteriaKey`/`values` spelling belongs
          // to the querycapabilities *response*, and sending it here is not an error the endpoint
          // reports - it answers 200 with an empty list, which is indistinguishable from an org
          // that captures no execution data. That cost weeks, hence the specificity of this note.
          query: [{ and: [{ key: 'ConversationId', operator: 'eq', value: conversationId }] }],
        },
        identity,
        budget,
        expectedStatuses: [404, 422],
      });

      if (!res.ok || !res.data) {
        failed += 1;
        logger.warn('ava.discovery.query_failed', { status: res.status, conversationId });
        continue;
      }

      const found: { executionId: string; flowId: string; flowVersion: string | null }[] = [];
      for (const entity of res.data.entities ?? []) {
        // `id` is the execution id; the entity is not required to echo the conversation back, so
        // the id we asked with is the one used for keying.
        if (!entity.id) continue;
        found.push({
          executionId: entity.id,
          flowId: entity.flowId ?? '',
          flowVersion: entity.flowVersion ?? null,
        });
      }
      if (found.length > 0) byConversation.set(conversationId, found);
    }
  }

  const workers = Math.min(DISCOVERY_CONCURRENCY, queue.length);
  await Promise.all(Array.from({ length: workers }, () => drain()));

  // Asked, matched and failed are reported together because a 200 with an empty list is the
  // endpoint's answer to several unrelated situations, and they need different responses. Failures
  // are counted separately so a rejected query can never again be read as an org that captures no
  // execution data.
  const matched = byConversation.size;
  if (conversationIds.length > 0 && matched === 0) {
    logger.warn('ava.discovery.no_executions', {
      asked: conversationIds.length,
      failed,
      hint:
        failed > 0
          ? 'Every query was rejected. Check the criteria against GET /flows/instances/querycapabilities.'
          : 'Queries succeeded and matched nothing. Execution data storage is off by default: Admin > Organization Settings > Settings > Execution Data, then republish the flows.',
    });
  } else if (matched < conversationIds.length) {
    logger.info('ava.discovery.partial_match', {
      asked: conversationIds.length,
      matched,
      failed,
    });
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
  };
}
