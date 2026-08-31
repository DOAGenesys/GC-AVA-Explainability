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

  it('returns null when nothing can identify the turn, so the caller can synthesise a key', () => {
    expect(turnKey({ sequenceNumber: 1 })).toBeNull();
    expect(turnKey({ sessionId: 'sess-9' })).toBeNull();
    expect(turnKey({})).toBeNull();
  });

  // The analytics dimensions for this same data use botSessionId where the sessions endpoint uses
  // sessionId, and the turn index has appeared as both sequenceNumber and turnNumber.
  it('accepts the alternative identifier names the platform uses elsewhere', () => {
    expect(turnKey({ botSessionId: 'bs-1', turnNumber: 2 })).toBe('bs-1:2');
    expect(turnKey({ session: { id: 'nested-1' }, sequence: 5 })).toBe('nested-1:5');
    expect(turnKey({ conversationId: 'conv-7', turnNumber: 0 })).toBe('conv-7:0');
    expect(turnKey({ turnId: 'explicit-1' })).toBe('explicit-1');
  });

  it('ignores empty strings and non-finite numbers rather than keying on them', () => {
    expect(turnKey({ sessionId: '', sequenceNumber: 1 })).toBeNull();
    expect(turnKey({ sessionId: 'sess-9', sequenceNumber: Number.NaN })).toBeNull();
  });

  // Genesys analytics serialises counters as strings in places. Rejecting those on type alone cost
  // both the natural key and the transcript ordering, so a numeric string counts as a sequence.
  it('accepts a sequence delivered as a numeric string', () => {
    expect(turnKey({ sessionId: 'sess-9', turnNumber: '3' })).toBe('sess-9:3');
    expect(turnKey({ sessionId: 'sess-9', sequenceNumber: ' 7 ' })).toBe('sess-9:7');
    expect(turnKey({ sessionId: 'sess-9', turnNumber: '0' })).toBe('sess-9:0');
  });

  it('does not mistake free text for a sequence', () => {
    expect(turnKey({ sessionId: 'sess-9', turnNumber: 'third' })).toBeNull();
    expect(turnKey({ sessionId: 'sess-9', turnNumber: '' })).toBeNull();
    expect(turnKey({ sessionId: 'sess-9', turnNumber: '2 turns' })).toBeNull();
  });

  // The live entity carries sessionId and dateCreated and no turn number whatsoever, so the
  // creation instant is the real natural key rather than a fallback.
  describe('with the shape the platform actually sends', () => {
    it('keys on the session and the creation instant', () => {
      expect(turnKey({ sessionId: 'sess-9', dateCreated: '2026-08-24T13:34:38.906Z' })).toBe(
        'sess-9:2026-08-24T13:34:38.906Z',
      );
    });

    it('still prefers an explicit sequence when one appears', () => {
      expect(
        turnKey({ sessionId: 'sess-9', turnNumber: 2, dateCreated: '2026-08-24T13:34:38.906Z' }),
      ).toBe('sess-9:2');
    });

    it('distinguishes turns within one session, so a transcript cannot collapse', () => {
      const first = turnKey({ sessionId: 's', dateCreated: '2026-08-24T13:34:38.906Z' });
      const second = turnKey({ sessionId: 's', dateCreated: '2026-08-24T13:34:39.882Z' });
      expect(first).not.toBe(second);
    });

    it('rejects a date it cannot parse rather than keying on nonsense', () => {
      expect(turnKey({ sessionId: 'sess-9', dateCreated: 'yesterday' })).toBeNull();
    });
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
