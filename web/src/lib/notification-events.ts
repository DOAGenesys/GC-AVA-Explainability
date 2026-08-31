export const FLOW_INSTANCE_TOPIC = {
  template: 'v2.flows.instances.flow.{id}',
  label: 'Flow execution completed',
  description:
    'Delivers the execution, flow and conversation identifiers needed to retrieve full execution history without discovery.',
  fields: ['executionId', 'conversationId', 'flowId', 'flowExitReason', 'execution'],
} as const;

/** Well below the Genesys 1,000-topic channel limit while remaining practical for an AVA estate. */
export const MAX_CAPTURE_FLOWS = 100;

export interface BuiltNotificationTopics {
  flowIds: string[];
  topics: string[];
  errors: string[];
}

export interface NormalizedNotification {
  topicName: string;
  body: unknown;
  raw: unknown;
}

export interface ExecutionPointer {
  executionId: string;
  flowId: string;
  conversationId: string;
}

export interface EventHighlight {
  key: string;
  value: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FLOW_INSTANCE_TOPIC_PATTERN = /^v2\.flows\.instances\.flow\.[^.]+$/i;

export function isGenesysId(value: string): boolean {
  return UUID.test(value);
}

/**
 * Accept pasted IDs separated by commas, spaces or newlines, normalize casing and preserve order.
 */
export function parseFlowIds(value: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const candidate of value.split(/[\s,;]+/)) {
    const id = candidate.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Build one concrete flow-instance topic per flow.
 *
 * WebSocket topics do not support wildcards; explicit IDs are the only reliable subscription
 * contract and are also what lets the UI describe exactly what it is capturing.
 */
export function buildNotificationTopics(input: { flowIds: string[] }): BuiltNotificationTopics {
  const flowIds = parseFlowIds(input.flowIds.join(','));
  const errors: string[] = [];

  if (flowIds.length === 0) errors.push('Add at least one flow.');
  if (flowIds.length > MAX_CAPTURE_FLOWS) {
    errors.push(`Capture supports up to ${MAX_CAPTURE_FLOWS} flows at once.`);
  }

  const invalid = flowIds.filter((flowId) => !isGenesysId(flowId));
  if (invalid.length > 0) {
    errors.push(
      `${invalid.length} flow ${invalid.length === 1 ? 'ID is' : 'IDs are'} not valid UUIDs.`,
    );
  }

  return {
    flowIds,
    topics:
      errors.length === 0
        ? flowIds.map((flowId) => FLOW_INSTANCE_TOPIC.template.replace('{id}', flowId))
        : [],
    errors,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Accept a direct WebSocket notification as well as an EventBridge-wrapped copy. */
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
  return FLOW_INSTANCE_TOPIC_PATTERN.test(topicName) ? FLOW_INSTANCE_TOPIC.label : topicName;
}

/**
 * Validate the zero-discovery pointer carried by a flow-instance notification.
 */
export function extractExecutionPointer(body: unknown): ExecutionPointer | null {
  const source = record(body);
  if (!source) return null;
  const execution = record(source.execution);
  const flow = record(execution?.flow);
  const conversation = record(execution?.conversation);

  const rawExecutionId = source.executionId ?? execution?.executionId ?? execution?.id;
  const rawFlowId = source.flowId ?? execution?.flowId ?? flow?.id;
  const rawConversationId = source.conversationId ?? execution?.conversationId ?? conversation?.id;

  const executionId = typeof rawExecutionId === 'string' ? rawExecutionId.trim() : '';
  const flowId = typeof rawFlowId === 'string' ? rawFlowId.trim() : '';
  const conversationId = typeof rawConversationId === 'string' ? rawConversationId.trim() : '';

  if (![executionId, flowId, conversationId].every(isGenesysId)) return null;
  return {
    executionId: executionId.toLowerCase(),
    flowId: flowId.toLowerCase(),
    conversationId: conversationId.toLowerCase(),
  };
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
    'flowId',
    'flowVersion',
    'flowType',
    'flowExitReason',
    'executionItemsTruncated',
    'endDateTime',
  ];
  const highlights: EventHighlight[] = [];
  for (const key of preferred) {
    const value = printable(source[key]);
    if (value !== null) highlights.push({ key, value });
  }
  return highlights;
}
