import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { buildSessionTimeline } from '@/lib/session-timeline';
import { parseTrace, type FlowExecutionTrace } from '@/server/genesys/ava';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/ava-execution-trace.json', import.meta.url), 'utf8'),
) as FlowExecutionTrace;

describe('buildSessionTimeline', () => {
  it('uses the Jobs trace to place each AVA tool after its triggering customer turn', () => {
    const timeline = buildSessionTimeline(parseTrace(fixture));

    expect(timeline.placedTools).toBe(3);
    expect(timeline.unplacedTools).toEqual([]);
    expect(timeline.source).toBe('trace');

    const compact = timeline.events.map((event) =>
      event.kind === 'tool' ? `tool:${event.call.toolName}` : `${event.kind}:${event.turnLabel}`,
    );
    expect(compact).toEqual([
      'ava:1',
      'customer:2',
      'tool:lookup_service_ticket',
      'ava:3',
      'customer:4',
      'tool:get_site_access_window',
      'ava:5',
      'customer:6',
      'tool:list_engineer_slots',
      'ava:7',
      'customer:8',
      'ava:9',
      'customer:10',
      'ava:11',
    ]);
  });

  it('returns an explicitly empty timeline when Jobs history is unavailable', () => {
    const timeline = buildSessionTimeline(null);

    expect(timeline.source).toBe('empty');
    expect(timeline.hasTrace).toBe(false);
    expect(timeline.events).toEqual([]);
    expect(timeline.placedTools).toBe(0);
  });
});
