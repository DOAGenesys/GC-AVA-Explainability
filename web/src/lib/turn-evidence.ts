/**
 * Reporting Turns evidence persisted by the server-side sweep (AWS, hourly).
 *
 * The sweep stores every AVA session Genesys Cloud reports, including sessions that never reached
 * their flow's exit and therefore have no execution history. Each turn carries the customer input,
 * the AVA prompts, the AVA's identity and its tool calls (name, type, status, latency), but not
 * tool inputs or outputs, which only exist in execution history.
 */

export interface TurnToolCall {
  toolName: string;
  toolType: string | null;
  toolId: string | null;
  targetId: string | null;
  status: string | null;
  origin: string | null;
  latencyMs: number | null;
  dateInvoked: string | null;
  errorText: string | null;
  knowledge: {
    knowledgeName: string | null;
    retrievalStatus: string | null;
    answerGenerationStatus: string | null;
    topConfidence: number | null;
    retrievedSources: number | null;
  } | null;
}

export interface TurnRecord {
  key: string;
  dateCreated: string | null;
  dateCompleted: string | null;
  userInput: string | null;
  botPrompts: string[];
  actionType: string | null;
  actionName: string | null;
  result: string | null;
  agentName: string | null;
  agentVersion: string | null;
  intent: string | null;
  toolCalls: TurnToolCall[];
  guardrails: { type: string | null; violationsTriggered: number | null }[];
  sessionEnd: { type: string | null; reason: string | null } | null;
}

export interface TurnSessionSummary {
  sessionId: string;
  conversationId: string | null;
  flowId: string;
  flowName: string | null;
  firstTurnAt: string;
  lastTurnAt: string | null;
  turnCount: number;
  toolCallCount: number;
  toolFailureCount: number;
  guardrailCount: number;
  agentName: string | null;
  agentVersion: string | null;
  endType: string | null;
  lastResult: string | null;
}

export interface TurnSession extends TurnSessionSummary {
  endReason: string | null;
  turns: TurnRecord[];
  turnsTruncated: boolean;
  updatedAt: string | null;
}

export interface SweepFlowStatus {
  flowId: string;
  flowName: string | null;
  lastRunAt: string | null;
  watermark: string | null;
  lastRunComplete: boolean;
  lastRunTurns: number;
  lastRunSessions: number;
  lastError: string | null;
}

export const TOOL_SUCCESS_STATUS = 'Success';

type Loose = Record<string, unknown>;

function asRecord(value: unknown): Loose | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function count(value: unknown): number {
  return Math.max(0, Math.trunc(num(value) ?? 0));
}

function parseToolCall(value: unknown): TurnToolCall | null {
  const call = asRecord(value);
  if (!call) return null;
  const knowledge = asRecord(call.knowledge);
  return {
    toolName: str(call.toolName) ?? '(unnamed tool)',
    toolType: str(call.toolType),
    toolId: str(call.toolId),
    targetId: str(call.targetId),
    status: str(call.status),
    origin: str(call.origin),
    latencyMs: num(call.latencyMs),
    dateInvoked: str(call.dateInvoked),
    errorText: str(call.errorText),
    knowledge: knowledge
      ? {
          knowledgeName: str(knowledge.knowledgeName),
          retrievalStatus: str(knowledge.retrievalStatus),
          answerGenerationStatus: str(knowledge.answerGenerationStatus),
          topConfidence: num(knowledge.topConfidence),
          retrievedSources: num(knowledge.retrievedSources),
        }
      : null,
  };
}

function parseTurn(value: unknown, index: number): TurnRecord | null {
  const turn = asRecord(value);
  if (!turn) return null;
  const end = asRecord(turn.sessionEnd);
  return {
    key: str(turn.key) ?? `turn-${index}`,
    dateCreated: str(turn.dateCreated),
    dateCompleted: str(turn.dateCompleted),
    userInput: str(turn.userInput),
    botPrompts: Array.isArray(turn.botPrompts)
      ? turn.botPrompts.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [],
    actionType: str(turn.actionType),
    actionName: str(turn.actionName),
    result: str(turn.result),
    agentName: str(turn.agentName),
    agentVersion: str(turn.agentVersion),
    intent: str(turn.intent),
    toolCalls: Array.isArray(turn.toolCalls)
      ? turn.toolCalls.map(parseToolCall).filter((c): c is TurnToolCall => c !== null)
      : [],
    guardrails: Array.isArray(turn.guardrails)
      ? turn.guardrails
          .map(asRecord)
          .filter((g): g is Loose => g !== null)
          .map((g) => ({ type: str(g.type), violationsTriggered: num(g.violationsTriggered) }))
      : [],
    sessionEnd: end ? { type: str(end.type), reason: str(end.reason) } : null,
  };
}

/** Parse the sweep's stored `turnsJson`. Malformed content yields no turns, never a throw. */
export function parseStoredTurns(raw: unknown): TurnRecord[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(parseTurn).filter((t): t is TurnRecord => t !== null);
}

/** Map a stored DynamoDB item (already unmarshalled) to a session summary. */
export function toTurnSessionSummary(item: Loose): TurnSessionSummary | null {
  const sessionId = str(item.sessionId);
  const firstTurnAt = str(item.firstTurnAt);
  if (!sessionId || !firstTurnAt) return null;
  return {
    sessionId,
    conversationId: str(item.conversationId),
    flowId: str(item.flowId) ?? 'unknown',
    flowName: str(item.flowName),
    firstTurnAt,
    lastTurnAt: str(item.lastTurnAt),
    turnCount: count(item.turnCount),
    toolCallCount: count(item.toolCallCount),
    toolFailureCount: count(item.toolFailureCount),
    guardrailCount: count(item.guardrailCount),
    agentName: str(item.agentName),
    agentVersion: str(item.agentVersion),
    endType: str(item.endType),
    lastResult: str(item.lastResult),
  };
}

export function toTurnSession(item: Loose): TurnSession | null {
  const summary = toTurnSessionSummary(item);
  if (!summary) return null;
  return {
    ...summary,
    endReason: str(item.endReason),
    turns: parseStoredTurns(item.turnsJson),
    turnsTruncated: item.turnsTruncated === true,
    updatedAt: str(item.updatedAt),
  };
}

export function toSweepFlowStatus(item: Loose): SweepFlowStatus | null {
  const flowId = str(item.flowId);
  if (!flowId) return null;
  return {
    flowId,
    flowName: str(item.flowName),
    lastRunAt: str(item.lastRunAt),
    watermark: str(item.watermark),
    lastRunComplete: item.lastRunComplete === true,
    lastRunTurns: count(item.lastRunTurns),
    lastRunSessions: count(item.lastRunSessions),
    lastError: str(item.lastError),
  };
}

export function isToolFailure(call: TurnToolCall): boolean {
  return call.status != null && call.status !== TOOL_SUCCESS_STATUS;
}

/** Human-readable session end, or null when Genesys has not reported one. */
export function describeSessionEnd(
  session: Pick<TurnSession, 'endType'> & { endReason?: string | null },
): string | null {
  if (!session.endType) return null;
  return session.endReason ? `${session.endType} · ${session.endReason}` : session.endType;
}

export interface SweepSummary {
  sessions: number;
  turns: number;
  withoutTrace: number;
  toolCalls: number;
  toolFailures: number;
  flows: number;
  flowsWithIssues: number;
  lastRunAt: string | null;
}

/** Coverage totals for the sweep, given which conversations already have a full trace. */
export function summarizeSweep(
  sessions: TurnSessionSummary[],
  flows: SweepFlowStatus[],
  archivedConversationIds: ReadonlySet<string>,
): SweepSummary {
  const lastRunAt = flows.reduce<string | null>(
    (latest, flow) =>
      flow.lastRunAt && (!latest || flow.lastRunAt > latest) ? flow.lastRunAt : latest,
    null,
  );
  return {
    sessions: sessions.length,
    turns: sessions.reduce((sum, session) => sum + session.turnCount, 0),
    withoutTrace: sessions.filter(
      (session) => !session.conversationId || !archivedConversationIds.has(session.conversationId),
    ).length,
    toolCalls: sessions.reduce((sum, session) => sum + session.toolCallCount, 0),
    toolFailures: sessions.reduce((sum, session) => sum + session.toolFailureCount, 0),
    flows: flows.length,
    flowsWithIssues: flows.filter((flow) => flow.lastError || !flow.lastRunComplete).length,
    lastRunAt,
  };
}

export interface SessionListRow {
  sessionId: string;
  flowId: string;
  flowName: string | null;
  conversationId: string | null;
  botResult: string | null;
  botResultCategory: string | null;
  dateCreated: string | null;
  turnCount: number;
  retrievalStatus: string | null;
  toolCallCount: number;
  source: 'analytics' | 'capture' | 'turns';
  turnEvidence: boolean;
}

/**
 * Merge stored sessions with sweep sessions. A sweep session whose conversation is already listed
 * enriches that row; any other becomes its own row, which is how sessions without execution
 * history become visible at all.
 */
export function mergeTurnSessions<T extends Omit<SessionListRow, 'turnEvidence'>>(
  rows: T[],
  turnSessions: TurnSessionSummary[],
  limit: number,
): ((T & { turnEvidence: boolean }) | SessionListRow)[] {
  const bySession = new Map(turnSessions.map((session) => [session.sessionId, session]));
  const byConversation = new Map<string, TurnSessionSummary>();
  for (const session of turnSessions) {
    if (session.conversationId && !byConversation.has(session.conversationId)) {
      byConversation.set(session.conversationId, session);
    }
  }
  const matched = new Set<string>();
  const merged: ((T & { turnEvidence: boolean }) | SessionListRow)[] = rows.map((row) => {
    const evidence =
      bySession.get(row.sessionId) ??
      (row.conversationId ? byConversation.get(row.conversationId) : undefined);
    if (!evidence) return { ...row, turnEvidence: false };
    matched.add(evidence.sessionId);
    return {
      ...row,
      turnEvidence: true,
      turnCount: Math.max(row.turnCount, evidence.turnCount),
      toolCallCount: Math.max(row.toolCallCount, evidence.toolCallCount),
    };
  });

  for (const session of turnSessions) {
    if (matched.has(session.sessionId)) continue;
    merged.push({
      sessionId: session.sessionId,
      flowId: session.flowId,
      flowName: session.flowName,
      conversationId: session.conversationId,
      botResult: session.endType ?? 'No exit reported',
      botResultCategory: null,
      dateCreated: session.firstTurnAt,
      turnCount: session.turnCount,
      retrievalStatus: null,
      toolCallCount: session.toolCallCount,
      source: 'turns',
      turnEvidence: true,
    });
  }

  return merged
    .sort((a, b) => Date.parse(b.dateCreated ?? '') - Date.parse(a.dateCreated ?? '') || 0)
    .slice(0, limit);
}
