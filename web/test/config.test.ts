import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetConfigCache,
  getReadiness,
  getServerConfig,
  normalizeRegionHost,
} from '@/server/config';

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

describe('event-driven configuration', () => {
  afterEach(() => {
    delete process.env.GENESYS_REGION;
    delete process.env.GENESYS_INGEST_CLIENT_ID;
    delete process.env.GENESYS_INGEST_CLIENT_SECRET;
    delete process.env.CRON_SECRET;
    __resetConfigCache();
  });

  it('uses the deployment region only as an optional sign-in default', () => {
    process.env.GENESYS_REGION = 'mypurecloud.de';
    __resetConfigCache();
    expect(getServerConfig().defaultRegionHost).toBe('api.mypurecloud.de');
  });

  it('does not require cron or client-credentials settings for readiness', () => {
    process.env.GENESYS_INGEST_CLIENT_ID = 'legacy-client';
    process.env.GENESYS_INGEST_CLIENT_SECRET = 'legacy-secret';
    process.env.CRON_SECRET = 'legacy-cron';
    __resetConfigCache();

    expect(getReadiness().missing).not.toEqual(
      expect.arrayContaining([
        'GENESYS_INGEST_CLIENT_ID',
        'GENESYS_INGEST_CLIENT_SECRET',
        'CRON_SECRET',
      ]),
    );
  });
});
