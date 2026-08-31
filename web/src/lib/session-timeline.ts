import type { TurnRow } from '@/server/db';
import type { AvaConversationTurn, ParsedTrace, ToolCall } from '@/server/genesys/ava';

export type ToolAssociation = 'trace-native' | 'transcript-match' | 'time-match';

export type SessionTimelineEvent =
  | {
      id: string;
      kind: 'customer' | 'ava';
      text: string;
      at: string | null;
      turnLabel: number;
      action: string | null;
      actionResult: string | null;
      source: 'reporting' | 'trace';
    }
  | {
      id: string;
      kind: 'tool';
      call: ToolCall;
      turnLabel: number;
      association: ToolAssociation;
    };

export interface SessionTimeline {
  events: SessionTimelineEvent[];
  unplacedTools: ToolCall[];
  flowTools: ToolCall[];
  reportingTurns: number;
  customerTurns: number;
  matchedTurns: number;
  avaTraceTurns: number;
  avaTools: number;
  placedTools: number;
  source: 'reporting' | 'trace' | 'empty';
  hasTrace: boolean;
  truncated: boolean;
}

interface TurnMatch {
  ava: AvaConversationTurn;
  association: Exclude<ToolAssociation, 'trace-native'>;
}

export function extractText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;

  if (Array.isArray(value)) {
    const parts = value.map(extractText).filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join('\n') : null;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'utterance', 'value', 'message', 'body']) {
      const candidate = extractText(record[key]);
      if (candidate) return candidate;
    }
    for (const key of ['prompts', 'messages', 'inputs', 'segments']) {
      const candidate = extractText(record[key]);
      if (candidate) return candidate;
    }
  }

  return null;
}

function normalizeUtterance(value: string | null): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function timestampDistance(turn: TurnRow, at: string | null): number | null {
  if (!at) return null;
  const target = Date.parse(at);
  if (!Number.isFinite(target)) return null;

  const candidates = [turn.turnStart, turn.turnEnd]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter(Number.isFinite);
  if (candidates.length === 0) return null;
  return Math.min(...candidates.map((value) => Math.abs(value - target)));
}

function findMatches(turns: TurnRow[], avaTurns: AvaConversationTurn[]): Map<string, TurnMatch> {
  const matches = new Map<string, TurnMatch>();
  const used = new Set<number>();
  let previousOrdinal = -1;

  for (const turn of turns) {
    const user = extractText(turn.userInput);
    const normalizedUser = normalizeUtterance(user);
    if (!normalizedUser) continue;

    let best:
      | {
          ava: AvaConversationTurn;
          association: Exclude<ToolAssociation, 'trace-native'>;
          score: number;
        }
      | undefined;

    for (const ava of avaTurns) {
      if (used.has(ava.ordinal) || !ava.customerText) continue;
      const normalizedTrace = normalizeUtterance(ava.customerText);
      const distance = timestampDistance(turn, ava.customerAt);
      const followsSequence = ava.ordinal > previousOrdinal;

      let score = -1;
      let association: Exclude<ToolAssociation, 'trace-native'> = 'time-match';

      if (normalizedTrace === normalizedUser) {
        score = 100_000;
        association = 'transcript-match';
      } else if (
        normalizedUser.length >= 16 &&
        (normalizedTrace.includes(normalizedUser) || normalizedUser.includes(normalizedTrace))
      ) {
        score = 80_000;
        association = 'transcript-match';
      } else if (distance != null && distance <= 20_000) {
        score = 50_000 - distance;
        association = 'time-match';
      }

      if (score < 0) continue;
      if (followsSequence) score += 2_000;
      if (distance != null) score += Math.max(0, 1_000 - Math.min(distance, 1_000));

      if (!best || score > best.score) best = { ava, association, score };
    }

    if (!best) continue;
    matches.set(turn.turnId, { ava: best.ava, association: best.association });
    used.add(best.ava.ordinal);
    previousOrdinal = best.ava.ordinal;
  }

  return matches;
}

export function buildSessionTimeline(turns: TurnRow[], trace: ParsedTrace | null): SessionTimeline {
  const events: SessionTimelineEvent[] = [];
  const toolByOrdinal = new Map(trace?.toolCalls.map((call) => [call.ordinal, call]) ?? []);
  const avaTools = trace?.toolCalls.filter((call) => call.source === 'ava') ?? [];
  const flowTools = trace?.toolCalls.filter((call) => call.source === 'flow') ?? [];
  const placed = new Set<number>();
  const matches = trace ? findMatches(turns, trace.avaTurns) : new Map<string, TurnMatch>();

  turns.forEach((turn, index) => {
    const user = extractText(turn.userInput);
    const ava = extractText(turn.botPrompts);
    const turnLabel = turn.sequence ?? index + 1;
    const match = matches.get(turn.turnId);

    if (user) {
      events.push({
        id: `${turn.turnId}:customer`,
        kind: 'customer',
        text: user,
        at: turn.turnStart,
        turnLabel,
        action: null,
        actionResult: null,
        source: 'reporting',
      });
    }

    for (const ordinal of match?.ava.toolOrdinals ?? []) {
      const call = toolByOrdinal.get(ordinal);
      if (!call) continue;
      placed.add(call.ordinal);
      events.push({
        id: `${turn.turnId}:tool:${call.ordinal}`,
        kind: 'tool',
        call,
        turnLabel,
        association: match!.association,
      });
    }

    if (ava) {
      events.push({
        id: `${turn.turnId}:ava`,
        kind: 'ava',
        text: ava,
        at: turn.turnEnd,
        turnLabel,
        action: turn.askAction,
        actionResult: turn.askActionResult,
        source: 'reporting',
      });
    }
  });

  // If reporting data expired or was not ingested, the trace still provides an exact, ordered
  // conversation. It is less durable than reporting turns, but better than hiding evidence.
  if (turns.length === 0 && trace) {
    trace.avaTurns.forEach((turn, index) => {
      const turnLabel = index + 1;
      if (turn.customerText) {
        events.push({
          id: `trace:${turn.ordinal}:customer`,
          kind: 'customer',
          text: turn.customerText,
          at: turn.customerAt,
          turnLabel,
          action: null,
          actionResult: null,
          source: 'trace',
        });
      }
      for (const ordinal of turn.toolOrdinals) {
        const call = toolByOrdinal.get(ordinal);
        if (!call) continue;
        placed.add(call.ordinal);
        events.push({
          id: `trace:${turn.ordinal}:tool:${call.ordinal}`,
          kind: 'tool',
          call,
          turnLabel,
          association: 'trace-native',
        });
      }
      if (turn.avaText) {
        events.push({
          id: `trace:${turn.ordinal}:ava`,
          kind: 'ava',
          text: turn.avaText,
          at: turn.avaAt,
          turnLabel,
          action: null,
          actionResult: null,
          source: 'trace',
        });
      }
    });
  }

  return {
    events,
    unplacedTools: avaTools.filter((call) => !placed.has(call.ordinal)),
    flowTools,
    reportingTurns: turns.length,
    customerTurns: turns.filter((turn) => Boolean(extractText(turn.userInput))).length,
    matchedTurns: matches.size,
    avaTraceTurns: trace?.avaTurns.length ?? 0,
    avaTools: avaTools.length,
    placedTools: placed.size,
    source: turns.length > 0 ? 'reporting' : trace ? 'trace' : 'empty',
    hasTrace: Boolean(trace),
    truncated: trace?.truncated ?? false,
  };
}
