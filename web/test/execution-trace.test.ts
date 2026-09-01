import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { isConfirmedNoHistory, parseTrace, type FlowExecutionTrace } from '@/server/genesys/ava';

/**
 * These assertions run against an unedited execution data export taken from Architect, because the
 * shape of this document is the one thing in the pipeline that cannot be reasoned about from the
 * API reference: the reference describes `flow.execution` as a list of typed items, and says
 * nothing about an AVA action carrying an entire nested conversation inside it.
 *
 * The parser originally looked for tool calls among the top-level `actionCallData` items, which is
 * where a flow's own Data Actions appear. A flow that delegates to an AVA has none - every tool the
 * model chose is nested - so it reported zero tool calls for exactly the executions it existed to
 * explain, while looking perfectly healthy. Hence a fixture rather than a hand-written document.
 */
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/ava-execution-trace.json', import.meta.url), 'utf8'),
) as FlowExecutionTrace;

describe('Jobs no-history classification', () => {
  it('accepts either string or numeric 404 only when the entity failed', () => {
    expect(isConfirmedNoHistory(true, '404')).toBe(true);
    expect(isConfirmedNoHistory(true, 404)).toBe(true);
    expect(isConfirmedNoHistory(false, 404)).toBe(false);
    expect(isConfirmedNoHistory(true, 500)).toBe(false);
  });
});

describe('parseTrace against a real Architect export', () => {
  it('reads the flow-level metadata the archive is keyed and filtered on', () => {
    const trace = parseTrace(fixture);

    expect(trace.executionId).toBe('2d99a529-a3a9-5bbb-8495-e77669c56a58');
    expect(trace.flowId).toBe('56155fa0-92cd-574b-b7cf-0fafad91fd2f');
    expect(trace.conversationId).toBe('7a4d8e6d-53de-5891-a916-78f31c24729d');
    expect(trace.flowType).toBe('digitalbot');
    expect(trace.flowVersion).toBe('4.0');
    expect(trace.truncated).toBe(false);
    expect(trace.durationMs).toBe(99_940);
    expect(trace.flowExitReason).toBe('DISCONNECT');
  });

  it('recovers every item type from its key, since the items carry no discriminant', () => {
    const trace = parseTrace(fixture);

    expect(trace.items.map((i) => i.kind)).toEqual([
      'startedFlow',
      'startedBotState',
      'actionCallAgenticVirtualAgent',
      'actionWaitForInput',
      'eventSessionDisconnected',
      'endedBotState',
      'endedFlow',
    ]);
  });

  it('finds the tool calls nested inside the AVA action, not at the top level', () => {
    const trace = parseTrace(fixture);

    // The document has no `actionCallData` item at all, so anything found here came from the AVA.
    expect(trace.items.some((i) => i.kind === 'actionCallData')).toBe(false);
    expect(trace.toolCalls.map((c) => c.toolName)).toEqual([
      'lookup_service_ticket',
      'get_site_access_window',
      'list_engineer_slots',
    ]);
  });

  it('preserves the AVA turn that triggered each tool call', () => {
    const trace = parseTrace(fixture);

    expect(trace.avaTurns).toHaveLength(11);
    expect(trace.toolCalls.map((call) => call.source)).toEqual(['ava', 'ava', 'ava']);
    expect(trace.toolCalls.map((call) => call.avaTurnIndex)).toEqual([1, 3, 5]);
    expect(trace.avaTurns[1]?.customerText).toBe("Hi, it's about service ticket FS-70118.");
    expect(trace.avaTurns[1]?.toolOrdinals).toEqual([0]);
    expect(trace.toolCalls[0]?.toolExecutionId).toBe('2d70bcca-0fa1-5176-a583-6f7316495e1b');
  });

  it('keys tool calls uniquely, because one AVA action hosts all of them', () => {
    const trace = parseTrace(fixture);
    const ordinals = trace.toolCalls.map((c) => c.ordinal);

    // (execution_id, ordinal) is the archive's primary key, so a shared host index would collide.
    expect(new Set(ordinals).size).toBe(ordinals.length);
    expect(new Set(trace.toolCalls.map((c) => c.parentOrdinal)).size).toBe(1);
  });

  it('unwraps the arguments the model chose and the response it got back', () => {
    const trace = parseTrace(fixture);
    const lookup = trace.toolCalls[0]!;

    expect(lookup.inputs).toEqual({ ticket_ref: 'FS-70118', site_contact_name: 'John' });
    // `successOutput` arrives as a JSON string; left unparsed it would render as one opaque line.
    expect(lookup.outputs.site_code).toBe('SITE-AMS-04');
    expect(lookup.outputs.required_skill_code).toBe('hvac_senior');
    expect(lookup.succeeded).toBe(true);
    expect(lookup.category).toBe('custom');
  });

  it('measures tool latency from the call itself rather than the next flow item', () => {
    const trace = parseTrace(fixture);

    expect(trace.toolCalls.map((c) => c.latencyMs)).toEqual([400, 391, 365]);
  });

  it('treats a tool that returned no successOutput as having taken the failure path', () => {
    // A real failure is absent from this export, so the condition is asserted on a copy with the
    // success payload removed - the distinction is drawn from that field and nothing else.
    const clone = JSON.parse(JSON.stringify(fixture)) as FlowExecutionTrace;
    const ava = clone.flow?.execution?.find(
      (item) => item.actionCallAgenticVirtualAgent,
    )?.actionCallAgenticVirtualAgent;
    const failing = (ava?.execution ?? []).flatMap((t) => t.turn?.tools ?? [])[0]!;
    delete failing.dataAction?.successOutput;
    failing.dataAction!.failureOutput = '{"error":"upstream timeout"}';

    const trace = parseTrace(clone);

    expect(trace.toolCalls[0]!.succeeded).toBe(false);
    expect(trace.toolCalls[0]!.outputs).toEqual({ error: 'upstream timeout' });
  });
});
