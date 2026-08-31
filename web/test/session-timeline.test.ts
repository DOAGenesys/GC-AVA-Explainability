import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { buildSessionTimeline } from '@/lib/session-timeline';
import type { TurnRow } from '@/server/db';
import { parseTrace, type FlowExecutionTrace } from '@/server/genesys/ava';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/ava-execution-trace.json', import.meta.url), 'utf8'),
) as FlowExecutionTrace;

function turn(
  turnId: string,
  userInput: string | null,
  botPrompts: string,
  turnStart: string,
  turnEnd: string,
): TurnRow {
  return {
    turnId,
    sequence: null,
    askAction: 'Call Agentic Virtual Agent',
    askActionResult: 'SuccessCollection',
    userInput,
    botPrompts: [botPrompts],
    turnStart,
    turnEnd,
  };
}

const reportingTurns: TurnRow[] = [
  turn(
    'greeting',
    null,
    "Hello, I'm Orin from Northwind Field Services.",
    '2026-08-31T16:46:09.349Z',
    '2026-08-31T16:46:09.349Z',
  ),
  turn(
    'lookup',
    "Hi, it's about service ticket FS-70118.",
    'John, your site is Amsterdam Data Hall 4.',
    '2026-08-31T16:46:13.175Z',
    '2026-08-31T16:46:20.894Z',
  ),
  turn(
    'access',
    'Thursday, please.',
    'John, the access window on Thursday is 08:00 to 18:00 CET.',
    '2026-08-31T16:46:25.373Z',
    '2026-08-31T16:46:34.446Z',
  ),
  turn(
    'engineer',
    'Yes, a security escort will be on site.',
    'No engineers are available for that day.',
    '2026-08-31T16:46:37.482Z',
    '2026-08-31T16:46:47.231Z',
  ),
];

describe('buildSessionTimeline', () => {
  it('places each AVA tool after the customer turn that triggered it', () => {
    const trace = parseTrace(fixture);
    const timeline = buildSessionTimeline(reportingTurns, trace);

    expect(timeline.placedTools).toBe(3);
    expect(timeline.unplacedTools).toEqual([]);
    expect(timeline.matchedTurns).toBe(3);

    const compact = timeline.events.map((event) =>
      event.kind === 'tool' ? `tool:${event.call.toolName}` : `${event.kind}:${event.turnLabel}`,
    );
    expect(compact).toEqual([
      'ava:1',
      'customer:2',
      'tool:lookup_service_ticket',
      'ava:2',
      'customer:3',
      'tool:get_site_access_window',
      'ava:3',
      'customer:4',
      'tool:list_engineer_slots',
      'ava:4',
    ]);
  });

  it('renders a reporting transcript without inventing tools when no trace exists', () => {
    const timeline = buildSessionTimeline(reportingTurns, null);

    expect(timeline.hasTrace).toBe(false);
    expect(timeline.placedTools).toBe(0);
    expect(timeline.events.some((event) => event.kind === 'tool')).toBe(false);
    expect(timeline.source).toBe('reporting');
  });

  it('keeps trace-proven tools visible but unlinked when transcript matching is unsafe', () => {
    const trace = parseTrace(fixture);
    const mismatched = reportingTurns.map((item) => ({
      ...item,
      userInput: item.userInput ? `Different message in ${item.turnId}` : null,
      turnStart: null,
      turnEnd: null,
    }));
    const timeline = buildSessionTimeline(mismatched, trace);

    expect(timeline.placedTools).toBe(0);
    expect(timeline.unplacedTools.map((call) => call.toolName)).toEqual([
      'lookup_service_ticket',
      'get_site_access_window',
      'list_engineer_slots',
    ]);
  });

  it('falls back to the ordered trace conversation when reporting turns are unavailable', () => {
    const trace = parseTrace(fixture);
    const timeline = buildSessionTimeline([], trace);

    expect(timeline.source).toBe('trace');
    expect(timeline.placedTools).toBe(3);
    expect(timeline.events.some((event) => event.kind === 'customer')).toBe(true);
    expect(timeline.events.some((event) => event.kind === 'ava')).toBe(true);
  });
});
