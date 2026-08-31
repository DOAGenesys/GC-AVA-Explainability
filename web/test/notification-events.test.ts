import { describe, expect, it } from 'vitest';
import {
  buildNotificationTopics,
  eventHighlights,
  extractExecutionPointer,
  normalizeNotification,
  parseFlowIds,
} from '@/lib/notification-events';

const FLOW_ID = '56155fa0-92cd-574b-b7cf-0fafad91fd2f';
const SECOND_FLOW_ID = '85fda89f-b22d-56df-90ae-9d49722751a0';
const EXECUTION_ID = '5c1550fd-dbb7-5da1-b337-25b42af123d7';
const CONVERSATION_ID = '33b6e980-095b-51a7-ae3e-02be439ac4bc';

describe('flow-instance topics', () => {
  it('builds one concrete subscription per unique flow', () => {
    expect(buildNotificationTopics({ flowIds: [FLOW_ID, SECOND_FLOW_ID, FLOW_ID] })).toEqual({
      flowIds: [FLOW_ID, SECOND_FLOW_ID],
      topics: [`v2.flows.instances.flow.${FLOW_ID}`, `v2.flows.instances.flow.${SECOND_FLOW_ID}`],
      errors: [],
    });
  });

  it('accepts comma, whitespace and newline separated flow lists', () => {
    expect(parseFlowIds(`${FLOW_ID},\n${SECOND_FLOW_ID} ${FLOW_ID}`)).toEqual([
      FLOW_ID,
      SECOND_FLOW_ID,
    ]);
  });

  it('rejects an empty or malformed flow list', () => {
    expect(buildNotificationTopics({ flowIds: [] }).errors).toContain('Add at least one flow.');
    expect(buildNotificationTopics({ flowIds: ['*'] }).errors[0]).toContain('not valid UUIDs');
  });
});

describe('flow-instance payload helpers', () => {
  const body = {
    executionId: EXECUTION_ID,
    conversationId: CONVERSATION_ID,
    flowId: FLOW_ID,
    flowVersion: '4.0',
    flowExitReason: 'DISCONNECT',
    executionItemsTruncated: false,
  };

  it('extracts the zero-discovery pointer from a real event shape', () => {
    expect(extractExecutionPointer(body)).toEqual({
      executionId: EXECUTION_ID,
      flowId: FLOW_ID,
      conversationId: CONVERSATION_ID,
    });
  });

  it('rejects an incomplete or malformed pointer before it can spend Jobs budget', () => {
    expect(extractExecutionPointer({ ...body, executionId: undefined })).toBeNull();
    expect(extractExecutionPointer({ ...body, flowId: '*' })).toBeNull();
  });

  it('accepts the identifiers from a nested execution object', () => {
    expect(
      extractExecutionPointer({
        execution: {
          id: EXECUTION_ID,
          flow: { id: FLOW_ID },
          conversation: { id: CONVERSATION_ID },
        },
      }),
    ).toEqual({
      executionId: EXECUTION_ID,
      flowId: FLOW_ID,
      conversationId: CONVERSATION_ID,
    });
  });

  it('unwraps direct WebSocket and EventBridge envelopes', () => {
    const websocket = {
      topicName: `v2.flows.instances.flow.${FLOW_ID}`,
      eventBody: body,
      metadata: { CorrelationId: 'abc' },
    };
    expect(normalizeNotification(websocket)).toMatchObject({
      topicName: websocket.topicName,
      body,
      raw: websocket,
    });
    expect(normalizeNotification({ detail: websocket }).body).toEqual(body);
  });

  it('exposes the identifiers and outcomes as copyable highlights', () => {
    expect(eventHighlights(body)).toEqual([
      { key: 'executionId', value: EXECUTION_ID },
      { key: 'conversationId', value: CONVERSATION_ID },
      { key: 'flowId', value: FLOW_ID },
      { key: 'flowVersion', value: '4.0' },
      { key: 'flowExitReason', value: 'DISCONNECT' },
      { key: 'executionItemsTruncated', value: 'false' },
    ]);
  });
});
