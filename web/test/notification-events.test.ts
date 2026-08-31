import { describe, expect, it } from 'vitest';
import {
  buildNotificationTopics,
  eventHighlights,
  normalizeNotification,
  notificationLabel,
} from '@/lib/notification-events';

const FLOW_ID = '56155fa0-92cd-574b-b7cf-0fafad91fd2f';
const CONVERSATION_ID = '7a4d8e6d-53de-5891-a916-78f31c24729d';

describe('buildNotificationTopics', () => {
  it('replaces every placeholder with the correct concrete id', () => {
    expect(
      buildNotificationTopics({
        selected: ['conversation-flow-end', 'flow-instance', 'flow-change'],
        flowId: FLOW_ID,
        conversationId: CONVERSATION_ID,
      }),
    ).toEqual({
      topics: [
        `v2.detail.events.conversation.${CONVERSATION_ID}.flow.end`,
        `v2.flows.instances.flow.${FLOW_ID}`,
        `v2.flows.${FLOW_ID}`,
      ],
      errors: [],
    });
  });

  it('requires only the identifier needed by the selected topic', () => {
    expect(
      buildNotificationTopics({
        selected: ['flow-instance'],
        flowId: FLOW_ID,
      }),
    ).toEqual({
      topics: [`v2.flows.instances.flow.${FLOW_ID}`],
      errors: [],
    });
  });

  it('rejects empty selections and malformed identifiers', () => {
    expect(buildNotificationTopics({ selected: [] }).errors).toContain(
      'Select at least one topic.',
    );
    expect(
      buildNotificationTopics({
        selected: ['conversation-flow-end'],
        conversationId: '*',
      }).errors,
    ).toContain('Enter a valid conversation ID for the selected conversation topic.');
  });
});

describe('notification payload helpers', () => {
  it('unwraps a direct WebSocket envelope', () => {
    const raw = {
      topicName: `v2.flows.instances.flow.${FLOW_ID}`,
      eventBody: { executionId: 'exec-1', flowId: FLOW_ID },
      metadata: { CorrelationId: 'abc' },
    };

    expect(normalizeNotification(raw)).toMatchObject({
      topicName: raw.topicName,
      body: raw.eventBody,
      raw,
    });
  });

  it('also unwraps an EventBridge detail envelope', () => {
    const raw = {
      detail: {
        topicName: `v2.flows.${FLOW_ID}`,
        eventBody: {
          id: FLOW_ID,
          currentOperation: { actionName: 'PUBLISH', actionStatus: 'SUCCESS' },
        },
      },
    };
    const normalized = normalizeNotification(raw);

    expect(notificationLabel(normalized.topicName)).toBe('Flow configuration changed');
    expect(eventHighlights(normalized.body)).toEqual([
      { key: 'id', value: FLOW_ID },
      { key: 'actionName', value: 'PUBLISH' },
      { key: 'actionStatus', value: 'SUCCESS' },
    ]);
  });
});
