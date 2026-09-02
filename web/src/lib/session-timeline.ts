import type { AvaConversationTurn, ParsedTrace, ToolCall } from '@/server/genesys/ava';

export type ToolAssociation = 'trace-native';

export type SessionTimelineEvent =
  | {
      id: string;
      kind: 'customer' | 'ava';
      text: string;
      at: string | null;
      turnLabel: number;
      action: null;
      actionResult: null;
      source: 'trace';
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
  avaTraceTurns: number;
  avaTools: number;
  placedTools: number;
  source: 'trace' | 'empty';
  hasTrace: boolean;
  truncated: boolean;
}

function appendTraceTurn(
  events: SessionTimelineEvent[],
  turn: AvaConversationTurn,
  index: number,
  toolByOrdinal: Map<number, ToolCall>,
  placed: Set<number>,
): void {
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
}

/** Build the conversation and tool timeline exclusively from Jobs execution history. */
export function buildSessionTimeline(trace: ParsedTrace | null): SessionTimeline {
  const events: SessionTimelineEvent[] = [];
  const toolByOrdinal = new Map(trace?.toolCalls.map((call) => [call.ordinal, call]) ?? []);
  const avaTools = trace?.toolCalls.filter((call) => call.source === 'ava') ?? [];
  const flowTools = trace?.toolCalls.filter((call) => call.source === 'flow') ?? [];
  const placed = new Set<number>();

  trace?.avaTurns.forEach((turn, index) => {
    appendTraceTurn(events, turn, index, toolByOrdinal, placed);
  });

  return {
    events,
    unplacedTools: avaTools.filter((call) => !placed.has(call.ordinal)),
    flowTools,
    avaTraceTurns: trace?.avaTurns.length ?? 0,
    avaTools: avaTools.length,
    placedTools: placed.size,
    source: trace ? 'trace' : 'empty',
    hasTrace: Boolean(trace),
    truncated: trace?.truncated ?? false,
  };
}
