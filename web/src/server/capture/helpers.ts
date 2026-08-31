/** Pure validation, dedup, and batching helpers for the event-to-Jobs capture path. */

export const CAPTURE_MAX_TRIPLES = 10;
export const CAPTURE_BATCH_SIZE = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CaptureTriple {
  executionId: string;
  flowId: string;
  conversationId: string;
}

export function isCaptureUuid(value: string): boolean {
  return UUID.test(value);
}

function normalizeUuidField(value: unknown, field: string): string | { error: string } {
  if (typeof value !== 'string') return { error: `${field} must be a string` };
  const trimmed = value.trim();
  if (!isCaptureUuid(trimmed)) return { error: `${field} must be a UUID` };
  return trimmed.toLowerCase();
}

export function validateCaptureTriple(
  value: unknown,
): { ok: true; triple: CaptureTriple } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'must be an object' };
  }

  const record = value as Record<string, unknown>;
  const executionId = normalizeUuidField(record.executionId, 'executionId');
  if (typeof executionId !== 'string') return { ok: false, error: executionId.error };

  const flowId = normalizeUuidField(record.flowId, 'flowId');
  if (typeof flowId !== 'string') return { ok: false, error: flowId.error };

  const conversationId = normalizeUuidField(record.conversationId, 'conversationId');
  if (typeof conversationId !== 'string') return { ok: false, error: conversationId.error };

  return {
    ok: true,
    triple: { executionId, flowId, conversationId },
  };
}

export function validateCaptureRequest(
  body: unknown,
): { ok: true; triples: CaptureTriple[] } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }

  const executions = (body as { executions?: unknown }).executions;
  if (!Array.isArray(executions)) {
    return { ok: false, error: 'executions must be an array' };
  }
  if (executions.length === 0) {
    return { ok: false, error: 'executions must not be empty' };
  }
  if (executions.length > CAPTURE_MAX_TRIPLES) {
    return {
      ok: false,
      error: `at most ${CAPTURE_MAX_TRIPLES} executions may be submitted per request`,
    };
  }

  const triples: CaptureTriple[] = [];
  for (let index = 0; index < executions.length; index += 1) {
    const parsed = validateCaptureTriple(executions[index]);
    if (!parsed.ok) {
      return { ok: false, error: `executions[${index}]: ${parsed.error}` };
    }
    triples.push(parsed.triple);
  }

  return { ok: true, triples };
}

export function dedupeCaptureTriples(triples: CaptureTriple[]): {
  unique: CaptureTriple[];
  duplicateExecutionIds: string[];
} {
  const seen = new Set<string>();
  const unique: CaptureTriple[] = [];
  const duplicateExecutionIds: string[] = [];

  for (const triple of triples) {
    const key = triple.executionId.toLowerCase();
    if (seen.has(key)) {
      duplicateExecutionIds.push(triple.executionId);
      continue;
    }
    seen.add(key);
    unique.push(triple);
  }

  return { unique, duplicateExecutionIds };
}

/** Split execution ids into fixed-size batches for Jobs submission. */
export function batchCaptureIds(ids: string[], batchSize = CAPTURE_BATCH_SIZE): string[][] {
  if (batchSize <= 0) return [];
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += batchSize) {
    batches.push(ids.slice(start, start + batchSize));
  }
  return batches;
}
