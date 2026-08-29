import { describe, expect, it } from 'vitest';

import { decryptJson, encryptJson } from '@/server/auth/secure-cookie';
import { redactUrl } from '@/server/logger';

const SECRET = 'test-secret-not-used-anywhere-real';
const TOKENS = { accessToken: 'at-123', refreshToken: 'rt-456', expiresAt: 1_800_000_000 };

describe('encryptJson / decryptJson', () => {
  it('round-trips a token payload', () => {
    expect(decryptJson(encryptJson(TOKENS, SECRET), SECRET)).toEqual(TOKENS);
  });

  it('never emits the plaintext, so the cookie is opaque to the browser', () => {
    const sealed = encryptJson(TOKENS, SECRET);
    expect(sealed).not.toContain('at-123');
    expect(sealed).not.toContain('rt-456');
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('uses a fresh IV, so the same input does not produce the same ciphertext', () => {
    expect(encryptJson(TOKENS, SECRET)).not.toBe(encryptJson(TOKENS, SECRET));
  });

  it('refuses a payload sealed with a different secret', () => {
    const sealed = encryptJson(TOKENS, SECRET);
    expect(() => decryptJson(sealed, 'other-secret')).toThrow();
  });

  it('refuses a tampered payload, because GCM authenticates the ciphertext', () => {
    const raw = Buffer.from(encryptJson(TOKENS, SECRET), 'base64url');
    const last = raw.length - 1;
    raw.writeUInt8(raw.readUInt8(last) ^ 0xff, last);
    expect(() => decryptJson(raw.toString('base64url'), SECRET)).toThrow();
  });
});

describe('redactUrl', () => {
  it('strips the query string, which is where Genesys puts signature material', () => {
    expect(redactUrl('https://api-downloads.mypurecloud.de/f.json?X-Amz-Signature=deadbeef')).toBe(
      'https://api-downloads.mypurecloud.de/f.json?[redacted]',
    );
  });

  it('leaves a query-less URL intact and never throws on junk', () => {
    expect(redactUrl('https://api.mypurecloud.de/api/v2/flows')).toBe(
      'https://api.mypurecloud.de/api/v2/flows',
    );
    expect(redactUrl('not a url')).toBe('[unparseable-url]');
  });
});
