import { describe, expect, it } from 'vitest';

import { normalizeRegionHost } from '@/server/config';

describe('normalizeRegionHost', () => {
  it('accepts a bare region domain', () => {
    expect(normalizeRegionHost('mypurecloud.de')).toBe('api.mypurecloud.de');
    expect(normalizeRegionHost('mypurecloud.com.au')).toBe('api.mypurecloud.com.au');
  });

  it('is idempotent on an already-prefixed api host', () => {
    expect(normalizeRegionHost('api.mypurecloud.de')).toBe('api.mypurecloud.de');
  });

  it('rewrites a login host to the api host, since users copy either one', () => {
    expect(normalizeRegionHost('login.mypurecloud.ie')).toBe('api.mypurecloud.ie');
  });

  it('accepts a full URL and tolerates whitespace and trailing slashes', () => {
    expect(normalizeRegionHost('https://api.mypurecloud.de/')).toBe('api.mypurecloud.de');
    expect(normalizeRegionHost('  MyPureCloud.DE  ')).toBe('api.mypurecloud.de');
  });

  it('rejects input that is not a plausible host', () => {
    for (const bad of [undefined, '', '   ', 'not-a-domain', 'mypurecloud.de/extra', 'https://']) {
      expect(normalizeRegionHost(bad)).toBeNull();
    }
  });
});
