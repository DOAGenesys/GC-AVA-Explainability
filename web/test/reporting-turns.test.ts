import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { cursorFromNextUri, turnKey, type TurnEntity } from '@/server/genesys/ava';

describe('turnKey', () => {
  it('prefers a platform-supplied id when one exists', () => {
    expect(turnKey({ id: 'turn-1', sessionId: 's', sequenceNumber: 0 })).toBe('turn-1');
  });

  it('derives a key from session and sequence, since a ReportingTurn carries no id', () => {
    expect(turnKey({ sessionId: 'sess-9', sequenceNumber: 3 })).toBe('sess-9:3');
  });

  it('treats sequence zero as a real sequence rather than missing', () => {
    expect(turnKey({ sessionId: 'sess-9', sequenceNumber: 0 })).toBe('sess-9:0');
  });

  it('falls back to the conversation when no session is present', () => {
    expect(turnKey({ conversation: { id: 'conv-4' }, sequenceNumber: 2 })).toBe('conv-4:2');
  });

  it('is deterministic, so repeated passes upsert rather than duplicate', () => {
    const entity: TurnEntity = { sessionId: 'sess-9', sequenceNumber: 3 };
    expect(turnKey(entity)).toBe(turnKey({ ...entity }));
  });

  it('returns null when nothing can identify the turn', () => {
    expect(turnKey({ sequenceNumber: 1 })).toBeNull();
    expect(turnKey({ sessionId: 'sess-9' })).toBeNull();
    expect(turnKey({})).toBeNull();
  });
});

describe('cursorFromNextUri', () => {
  it('extracts the after cursor from the relative nextUri the platform returns', () => {
    const nextUri = '/api/v2/analytics/botflows/abc/reportingturns?pageSize=100&after=CURSOR123';
    expect(cursorFromNextUri(nextUri)).toBe('CURSOR123');
  });

  it('handles an absolute nextUri', () => {
    const nextUri = 'https://api.mypurecloud.de/api/v2/analytics/botflows/a/reportingturns?after=X';
    expect(cursorFromNextUri(nextUri)).toBe('X');
  });

  it('returns null when there is no further page', () => {
    expect(cursorFromNextUri(undefined)).toBeNull();
    expect(cursorFromNextUri('')).toBeNull();
  });

  it('returns null when the uri carries no cursor, so paging stops instead of looping', () => {
    expect(
      cursorFromNextUri('/api/v2/analytics/botflows/a/reportingturns?pageSize=100'),
    ).toBeNull();
  });
});
