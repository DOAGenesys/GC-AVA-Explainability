import { describe, expect, it } from 'vitest';

import {
  describeSessionEnd,
  isToolFailure,
  mergeTurnSessions,
  parseStoredTurns,
  summarizeSweep,
  toSweepFlowStatus,
  toTurnSession,
  toTurnSessionSummary,
  type SessionListRow,
  type TurnSessionSummary,
} from '@/lib/turn-evidence';

const storedTurns = JSON.stringify([
  {
    key: '2026-10-26T10:00:00.000Z|1|frame-1',
    dateCreated: '2026-10-26T10:00:00.000Z',
    userInput: 'synthetic question',
    botPrompts: ['synthetic answer', '', 7],
    result: 'Success',
    agentName: 'Synthetic AVA',
    agentVersion: '3',
    toolCalls: [
      { toolName: 'lookup', status: 'Success', latencyMs: 120, toolType: 'DataAction' },
      { status: 'Failure', latencyMs: '45' },
      'not a call',
    ],
    guardrails: [{ type: 'Topic', violationsTriggered: 1 }],
    sessionEnd: { type: 'Exit', reason: 'Completed' },
  },
  'not a turn',
]);

function firstTurn() {
  const turn = parseStoredTurns(storedTurns)[0];
  if (!turn) throw new Error('fixture has no valid turn');
  return turn;
}

function summary(overrides: Partial<TurnSessionSummary>): TurnSessionSummary {
  return {
    sessionId: 's-1',
    conversationId: 'c-1',
    flowId: 'f-1',
    flowName: 'Flow',
    firstTurnAt: '2026-10-26T10:00:00.000Z',
    lastTurnAt: null,
    turnCount: 4,
    toolCallCount: 2,
    toolFailureCount: 0,
    guardrailCount: 0,
    agentName: null,
    agentVersion: null,
    endType: null,
    lastResult: null,
    ...overrides,
  };
}

function row(overrides: Partial<Omit<SessionListRow, 'turnEvidence'>>) {
  return {
    sessionId: 'a-1',
    flowId: 'f-1',
    flowName: 'Flow',
    conversationId: null,
    botResult: 'Completed',
    botResultCategory: null,
    dateCreated: '2026-10-26T09:00:00.000Z',
    turnCount: 0,
    retrievalStatus: 'ARCHIVED',
    toolCallCount: 0,
    source: 'analytics' as const,
    ...overrides,
  };
}

describe('parseStoredTurns', () => {
  it('keeps valid turns and tool calls and drops malformed entries', () => {
    const turns = parseStoredTurns(storedTurns);
    expect(turns).toHaveLength(1);
    const turn = firstTurn();
    expect(turn.botPrompts).toEqual(['synthetic answer']);
    expect(turn.toolCalls.map((call) => call.toolName)).toEqual(['lookup', '(unnamed tool)']);
    expect(turn.toolCalls[1]?.latencyMs).toBe(45);
    expect(turn.sessionEnd).toEqual({ type: 'Exit', reason: 'Completed' });
  });

  it('returns no turns for missing or invalid JSON', () => {
    expect(parseStoredTurns(undefined)).toEqual([]);
    expect(parseStoredTurns('{')).toEqual([]);
    expect(parseStoredTurns('{"a":1}')).toEqual([]);
  });
});

describe('stored item mapping', () => {
  it('requires a session id and first turn time', () => {
    expect(toTurnSessionSummary({ sessionId: 's-1' })).toBeNull();
    expect(toTurnSessionSummary({ firstTurnAt: '2026-10-26T10:00:00Z' })).toBeNull();
  });

  it('maps a full session with its turns', () => {
    const session = toTurnSession({
      sessionId: 's-1',
      firstTurnAt: '2026-10-26T10:00:00.000Z',
      turnCount: 1,
      toolCallCount: '2',
      endType: 'Exit',
      endReason: 'Completed',
      turnsJson: storedTurns,
      turnsTruncated: true,
    });
    expect(session?.toolCallCount).toBe(2);
    expect(session?.turns).toHaveLength(1);
    expect(session?.turnsTruncated).toBe(true);
    expect(session && describeSessionEnd(session)).toBe('Exit · Completed');
  });

  it('maps sweep status items', () => {
    expect(toSweepFlowStatus({ flowName: 'x' })).toBeNull();
    expect(
      toSweepFlowStatus({ flowId: 'f-1', lastRunComplete: true, lastRunTurns: 3 }),
    ).toMatchObject({
      flowId: 'f-1',
      lastRunComplete: true,
      lastRunTurns: 3,
      lastError: null,
    });
  });

  it('treats only reported non-success statuses as tool failures', () => {
    expect(firstTurn().toolCalls.map(isToolFailure)).toEqual([false, true]);
  });
});

describe('mergeTurnSessions', () => {
  it('enriches a listed session matched by session id or conversation', () => {
    const merged = mergeTurnSessions(
      [row({ sessionId: 's-1' }), row({ sessionId: 'a-2', conversationId: 'c-2' })],
      [summary({}), summary({ sessionId: 's-2', conversationId: 'c-2', turnCount: 6 })],
      10,
    );
    expect(merged).toHaveLength(2);
    expect(merged.every((r) => r.turnEvidence)).toBe(true);
    expect(merged.find((r) => r.sessionId === 'a-2')?.turnCount).toBe(6);
  });

  it('adds sessions known only from reporting turns, newest first, within the limit', () => {
    const merged = mergeTurnSessions(
      [row({})],
      [
        summary({ sessionId: 's-new', firstTurnAt: '2026-10-26T11:00:00.000Z' }),
        summary({
          sessionId: 's-old',
          conversationId: null,
          firstTurnAt: '2026-10-20T11:00:00.000Z',
        }),
      ],
      2,
    );
    expect(merged.map((r) => r.sessionId)).toEqual(['s-new', 'a-1']);
    expect(merged[0]).toMatchObject({
      source: 'turns',
      botResult: 'No exit reported',
      retrievalStatus: null,
    });
  });
});

describe('summarizeSweep', () => {
  it('counts sessions without a full trace and flows needing attention', () => {
    const result = summarizeSweep(
      [summary({}), summary({ sessionId: 's-2', conversationId: 'c-2', toolFailureCount: 1 })],
      [
        {
          flowId: 'f-1',
          flowName: null,
          lastRunAt: '2026-10-26T12:00:00.000Z',
          watermark: null,
          lastRunComplete: true,
          lastRunTurns: 1,
          lastRunSessions: 1,
          lastError: null,
        },
        {
          flowId: 'f-2',
          flowName: null,
          lastRunAt: '2026-10-26T11:00:00.000Z',
          watermark: null,
          lastRunComplete: false,
          lastRunTurns: 0,
          lastRunSessions: 0,
          lastError: 'reporting turns returned 400',
        },
      ],
      new Set(['c-1']),
    );
    expect(result).toMatchObject({
      sessions: 2,
      turns: 8,
      withoutTrace: 1,
      toolCalls: 4,
      toolFailures: 1,
      flows: 2,
      flowsWithIssues: 1,
      lastRunAt: '2026-10-26T12:00:00.000Z',
    });
  });
});
