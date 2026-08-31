import { afterEach, describe, expect, it } from 'vitest';

import { __resetConfigCache, getServerConfig, normalizeRegionHost } from '@/server/config';

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

describe('ingestion lookback windows', () => {
  afterEach(() => {
    delete process.env.INGEST_LOOKBACK_MINUTES;
    delete process.env.INGEST_TURNS_LOOKBACK_MINUTES;
    __resetConfigCache();
  });

  // Reusing the session window for turns silently stopped turn capture once: a four-hour window
  // returned nothing for sessions days old, and because the platform deletes turns after 10 days
  // that gap was unrecoverable. The turn window must stay wide regardless of the session window.
  it('defaults the turn window to the full upstream retention period', () => {
    __resetConfigCache();
    expect(getServerConfig().ingestion.turnsLookbackMinutes).toBe(14_400);
  });

  it('keeps the turn window independent of a narrowed session window', () => {
    process.env.INGEST_LOOKBACK_MINUTES = '15';
    __resetConfigCache();

    const { lookbackMinutes, turnsLookbackMinutes } = getServerConfig().ingestion;
    expect(lookbackMinutes).toBe(15);
    expect(turnsLookbackMinutes).toBeGreaterThan(lookbackMinutes);
  });

  it('still allows the turn window to be tuned explicitly', () => {
    process.env.INGEST_TURNS_LOOKBACK_MINUTES = '600';
    __resetConfigCache();
    expect(getServerConfig().ingestion.turnsLookbackMinutes).toBe(600);
  });
});
