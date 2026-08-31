import 'server-only';

/**
 * Server configuration, parsed lazily from the environment and memoized. Secrets are read here
 * but NEVER returned to the browser - only readiness booleans and non-secret limits cross over.
 *
 * Genesys operations use the signed-in user's Authorization Code + PKCE session. The deployment can
 * provide a default region for the login form, but it stores no background Genesys credential.
 */

function int(value: string | undefined, fallback: number): number {
  const n = value != null ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Normalize a Genesys region input (e.g. mypurecloud.de) to an API host (api.mypurecloud.de).
 * Accepts bare region domains, api./login. prefixes, or full https URLs.
 */
export function normalizeRegionHost(raw: string | undefined): string | null {
  if (!raw) return null;
  let host: string;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      host = new URL(trimmed).hostname.toLowerCase();
    } catch {
      return null;
    }
  } else {
    if (trimmed.includes('/')) return null;
    host = trimmed.toLowerCase();
  }
  host = host.replace(/^login\./, '').replace(/^api\./, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return null;
  return `api.${host}`;
}

export interface ServerConfig {
  auth: {
    sessionSecret: string | null;
    sessionTtlMinutes: number;
    configured: boolean;
  };
  defaultRegionHost: string | null;
  /** Measured Jobs API acceptance ceiling. Not a tuning knob - 11 ids is a hard 422. */
  jobsMaxIdsPerRequest: number;
  environmentLabel: string;
  appVersion: string;
}

let cached: ServerConfig | null = null;

export function getServerConfig(): ServerConfig {
  if (cached) return cached;

  const sessionSecret = process.env.APP_SESSION_SECRET || null;
  const defaultRegionHost = normalizeRegionHost(process.env.GENESYS_REGION);

  cached = {
    auth: {
      sessionSecret,
      sessionTtlMinutes: int(process.env.SESSION_TTL_MINUTES, 720),
      configured: Boolean(sessionSecret),
    },
    defaultRegionHost,
    jobsMaxIdsPerRequest: int(process.env.JOBS_MAX_IDS, 10),
    environmentLabel: process.env.NEXT_PUBLIC_ENVIRONMENT_LABEL?.trim() || 'local',
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION?.trim() || '0.1.0',
  };
  return cached;
}

/** Reset memoized config (tests only). */
export function __resetConfigCache(): void {
  cached = null;
}

export interface ReadinessReport {
  authConfigured: boolean;
  databaseConfigured: boolean;
  missing: string[];
  environmentLabel: string;
  appVersion: string;
}

export function getReadiness(): ReadinessReport {
  const cfg = getServerConfig();
  const missing: string[] = [];
  if (!cfg.auth.sessionSecret) missing.push('APP_SESSION_SECRET');
  if (!process.env.POSTGRES_URL) missing.push('POSTGRES_URL');

  return {
    authConfigured: cfg.auth.configured,
    databaseConfigured: Boolean(process.env.POSTGRES_URL),
    missing,
    environmentLabel: cfg.environmentLabel,
    appVersion: cfg.appVersion,
  };
}
