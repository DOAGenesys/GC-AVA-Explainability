export const NOTIFICATION_TOPICS = [
  {
    key: 'conversation-flow-end',
    template: 'v2.detail.events.conversation.{id}.flow.end',
    label: 'Conversation flow ended',
    description:
      'Signals how a flow left a specific conversation, including exit reason, transfer and disconnect context.',
    idKind: 'conversation',
    fields: ['conversationId', 'sessionId', 'flowId', 'exitReason', 'disconnectType'],
  },
  {
    key: 'flow-instance',
    template: 'v2.flows.instances.flow.{id}',
    label: 'Flow execution completed',
    description:
      'The high-value execution signal: execution ID, flow version, exit reason, errors, warnings and the inline action summary.',
    idKind: 'flow',
    fields: ['executionId', 'conversationId', 'flowId', 'flowExitReason', 'execution'],
  },
  {
    key: 'flow-change',
    template: 'v2.flows.{id}',
    label: 'Flow configuration changed',
    description:
      'Reports Architect lifecycle changes such as save, check-in, publish, delete and validation operations.',
    idKind: 'flow',
    fields: ['id', 'name', 'deleted', 'publishedVersion', 'currentOperation'],
  },
] as const;

export type NotificationTopicKey = (typeof NOTIFICATION_TOPICS)[number]['key'];
export type NotificationTargetKind = (typeof NOTIFICATION_TOPICS)[number]['idKind'];

export interface NotificationTopicInput {
  selected: NotificationTopicKey[];
  flowId?: string;
  conversationId?: string;
}

export interface BuiltNotificationTopics {
  topics: string[];
  errors: string[];
}

export interface NormalizedNotification {
  topicName: string;
  body: unknown;
  raw: unknown;
}

export interface EventHighlight {
  key: string;
  value: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOPIC_KEYS = new Set<string>(NOTIFICATION_TOPICS.map((topic) => topic.key));

export function isNotificationTopicKey(value: unknown): value is NotificationTopicKey {
  return typeof value === 'string' && TOPIC_KEYS.has(value);
}

/**
 * Replace the topic placeholders with concrete identifiers.
 *
 * WebSocket notification topics do not support wildcards. Requiring the relevant identifier here
 * prevents a syntactically valid subscription that can never receive the event the user expects.
 */
export function buildNotificationTopics(input: NotificationTopicInput): BuiltNotificationTopics {
  const selected = [...new Set(input.selected)].filter(isNotificationTopicKey);
  const errors: string[] = [];
  const topics: string[] = [];
  const flowId = input.flowId?.trim() ?? '';
  const conversationId = input.conversationId?.trim() ?? '';

  if (selected.length === 0) errors.push('Select at least one topic.');

  const needsFlow = selected.some(
    (key) => NOTIFICATION_TOPICS.find((topic) => topic.key === key)?.idKind === 'flow',
  );
  const needsConversation = selected.some(
    (key) => NOTIFICATION_TOPICS.find((topic) => topic.key === key)?.idKind === 'conversation',
  );

  if (needsFlow && !UUID.test(flowId)) {
    errors.push('Enter a valid flow ID for the selected flow topics.');
  }
  if (needsConversation && !UUID.test(conversationId)) {
    errors.push('Enter a valid conversation ID for the selected conversation topic.');
  }
  if (errors.length > 0) return { topics, errors };

  for (const definition of NOTIFICATION_TOPICS) {
    if (!selected.includes(definition.key)) continue;
    const id = definition.idKind === 'flow' ? flowId : conversationId;
    topics.push(definition.template.replace('{id}', id));
  }

  return { topics, errors };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Accept a direct WebSocket notification as well as an EventBridge-wrapped copy.
 *
 * The latter is useful when users paste events captured by the production transport into the live
 * viewer or its tests: EventBridge adds `detail`, then Genesys adds `eventBody`.
 */
export function normalizeNotification(value: unknown): NormalizedNotification {
  const raw = value;
  let envelope = record(value);
  const detail = record(envelope?.detail);
  if (detail) envelope = detail;

  const topicName =
    typeof envelope?.topicName === 'string' ? envelope.topicName : 'Unidentified notification';
  const body = envelope && 'eventBody' in envelope ? envelope.eventBody : (envelope ?? value);
  return { topicName, body, raw };
}

export function notificationLabel(topicName: string): string {
  if (/^v2\.detail\.events\.conversation\.[^.]+\.flow\.end$/i.test(topicName)) {
    return 'Conversation flow ended';
  }
  if (/^v2\.flows\.instances\.flow\.[^.]+$/i.test(topicName)) {
    return 'Flow execution completed';
  }
  if (/^v2\.flows\.[^.]+$/i.test(topicName)) return 'Flow configuration changed';
  return topicName;
}

function printable(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Compact, copyable identifiers and outcomes shown above an event's complete JSON. */
export function eventHighlights(body: unknown): EventHighlight[] {
  const source = record(body);
  if (!source) return [];

  const preferred = [
    'executionId',
    'conversationId',
    'sessionId',
    'flowId',
    'id',
    'name',
    'flowVersion',
    'flowType',
    'flowExitReason',
    'exitReason',
    'disconnectType',
    'deleted',
    'actionName',
    'actionStatus',
  ];
  const highlights: EventHighlight[] = [];

  for (const key of preferred) {
    const value = printable(source[key]);
    if (value !== null) highlights.push({ key, value });
  }

  const operation = record(source.currentOperation);
  for (const key of ['actionName', 'actionStatus']) {
    const value = printable(operation?.[key]);
    if (value !== null && !highlights.some((entry) => entry.key === key)) {
      highlights.push({ key, value });
    }
  }

  return highlights.slice(0, 8);
}
