import { describe, expect, it } from 'vitest';

import {
  randomToken,
  signSession,
  timingSafeEqual,
  verifySession,
  verifyToken,
} from '@/server/auth/session-core';

const SECRET = 'test-secret-not-used-anywhere-real';
const NOW = 1_800_000_000;

function session(overrides: Partial<{ sub: string; iat: number; exp: number }> = {}) {
  return { sub: 'alex@example.com', iat: NOW, exp: NOW + 600, ...overrides };
}

describe('timingSafeEqual', () => {
  it('matches identical strings and rejects differences', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });

  it('rejects on length mismatch rather than comparing a prefix', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', 'a')).toBe(false);
  });
});

describe('signSession / verifySession', () => {
  it('round-trips a valid session', async () => {
    const token = await signSession(session(), SECRET);
    await expect(verifySession(token, SECRET, NOW)).resolves.toMatchObject({
      sub: 'alex@example.com',
    });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signSession(session(), SECRET);
    await expect(verifySession(token, 'other-secret', NOW)).resolves.toBeNull();
  });

  it('rejects a tampered payload, because the signature no longer covers it', async () => {
    const token = await signSession(session(), SECRET);
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify(session({ sub: 'admin@example.com' })))
      .toString('base64url')
      .replace(/=+$/, '');
    await expect(verifySession(`${forged}.${sig}`, SECRET, NOW)).resolves.toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const token = await signSession(session(), SECRET);
    const [body, sig] = token.split('.');
    const flipped = `${sig!.slice(0, -1)}${sig!.slice(-1) === 'A' ? 'B' : 'A'}`;
    await expect(verifySession(`${body}.${flipped}`, SECRET, NOW)).resolves.toBeNull();
  });

  it('rejects an expired session even though the signature is valid', async () => {
    const token = await signSession(session({ exp: NOW - 1 }), SECRET);
    await expect(verifySession(token, SECRET, NOW)).resolves.toBeNull();
  });

  it('rejects a correctly signed token that carries no expiry', async () => {
    const token = await signSession(
      { sub: 'alex@example.com', iat: NOW } as never as ReturnType<typeof session>,
      SECRET,
    );
    await expect(verifySession(token, SECRET, NOW)).resolves.toBeNull();
  });

  it('rejects a correctly signed token with an empty subject', async () => {
    const token = await signSession(session({ sub: '' }), SECRET);
    await expect(verifySession(token, SECRET, NOW)).resolves.toBeNull();
  });

  it('rejects malformed input instead of throwing', async () => {
    for (const bad of [undefined, null, '', 'no-dot', '.onlysig']) {
      await expect(verifyToken(bad, SECRET, NOW)).resolves.toBeNull();
    }
  });
});

describe('randomToken', () => {
  it('produces url-safe, non-repeating values', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
