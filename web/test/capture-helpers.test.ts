import { describe, expect, it } from 'vitest';

import {
  batchCaptureIds,
  CAPTURE_MAX_TRIPLES,
  dedupeCaptureTriples,
  validateCaptureRequest,
  validateCaptureTriple,
} from '@/server/capture/helpers';

const EXECUTION_ID = 'e56de3cf-1e40-5b6b-aad3-4a6b2b575c7f';
const FLOW_ID = '56155fa0-92cd-574b-b7cf-0fafad91fd2f';
const CONVERSATION_ID = '7a4d8e6d-53de-5891-a916-78f31c24729d';

function validTriple(overrides: Partial<Record<string, string>> = {}) {
  return {
    executionId: EXECUTION_ID,
    flowId: FLOW_ID,
    conversationId: CONVERSATION_ID,
    ...overrides,
  };
}

describe('validateCaptureTriple', () => {
  it('accepts a well-formed triple', () => {
    const parsed = validateCaptureTriple(validTriple());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.triple).toEqual({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        conversationId: CONVERSATION_ID,
      });
    }
  });

  it('trims UUID fields before validating', () => {
    const parsed = validateCaptureTriple(validTriple({ executionId: `  ${EXECUTION_ID}  ` }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.triple.executionId).toBe(EXECUTION_ID);
  });

  it('rejects non-UUID identifiers', () => {
    const parsed = validateCaptureTriple(validTriple({ flowId: 'not-a-uuid' }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('flowId');
  });
});

describe('validateCaptureRequest', () => {
  it('accepts up to the configured maximum', () => {
    const executions = Array.from({ length: CAPTURE_MAX_TRIPLES }, (_, index) =>
      validTriple({
        executionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      }),
    );
    const parsed = validateCaptureRequest({ executions });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.triples).toHaveLength(CAPTURE_MAX_TRIPLES);
  });

  it('rejects more than the configured maximum', () => {
    const executions = Array.from({ length: CAPTURE_MAX_TRIPLES + 1 }, (_, index) =>
      validTriple({
        executionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      }),
    );
    const parsed = validateCaptureRequest({ executions });
    expect(parsed.ok).toBe(false);
  });

  it('rejects an empty executions array', () => {
    const parsed = validateCaptureRequest({ executions: [] });
    expect(parsed.ok).toBe(false);
  });
});

describe('dedupeCaptureTriples', () => {
  it('keeps the first triple for a repeated execution id', () => {
    const first = validTriple({ flowId: '11111111-1111-4111-8111-111111111111' });
    const second = validTriple({
      executionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      flowId: '22222222-2222-4222-8222-222222222222',
    });
    const { unique, duplicateExecutionIds } = dedupeCaptureTriples([first, second, validTriple()]);

    expect(unique).toHaveLength(2);
    expect(unique[0]?.flowId).toBe(first.flowId);
    expect(duplicateExecutionIds).toEqual([EXECUTION_ID]);
  });
});

describe('batchCaptureIds', () => {
  it('splits ids into fixed-size batches', () => {
    const ids = Array.from({ length: 23 }, (_, index) => `id-${index}`);
    expect(batchCaptureIds(ids, 10)).toEqual([
      ids.slice(0, 10),
      ids.slice(10, 20),
      ids.slice(20, 23),
    ]);
  });

  it('returns an empty list for an empty input', () => {
    expect(batchCaptureIds([])).toEqual([]);
  });
});
