import 'server-only';

/**
 * Server configuration, parsed lazily from the environment and memoized. Secrets are read here
 * but NEVER returned to the browser - only readiness booleans and non-secret limits cross over.
 *
 * There are deliberately two Genesys identities:
 *
 *   - **Interactive**: the signed-in user's own Authorization Code + PKCE session. The app boots
 *     with no server-side credentials; the user supplies region and client id at sign-in, exactly
 *     as in GC_Knowledge_File_Handler. Everything a human triggers runs as that human.
 *   - **Ingestion**: a client-credentials grant used only by the Vercel cron routes. Background
 *     ingestion cannot borrow a user's cookie, and tying an org-wide observability archive to one
 *     person's session would make the archive stop the day they leave.
 */

function int(value: string | undefined, fallback: number): number {
  const n = value != null ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
  ingestion: {
    clientId: string | null;
    clientSecret: string | null;
    regionHost: string | null;
    cronSecret: string | null;
    configured: boolean;
    /** Flow ids to ingest. Empty means "every flow whose AVA flag is set", resolved at runtime. */
    flowIds: string[];
    lookbackMinutes: number;
    maxExecutionsPerRun: number;
  };
  /** Measured Jobs API acceptance ceiling. Not a tuning knob - 11 ids is a hard 422. */
  jobsMaxIdsPerRequest: number;
  environmentLabel: string;
  appVersion: string;
}

let cached: ServerConfig | null = null;

export function getServerConfig(): ServerConfig {
  if (cached) return cached;

  const sessionSecret = process.env.APP_SESSION_SECRET || null;
  const clientId = process.env.GENESYS_INGEST_CLIENT_ID?.trim() || null;
  const clientSecret = process.env.GENESYS_INGEST_CLIENT_SECRET?.trim() || null;
  const regionHost = normalizeRegionHost(process.env.GENESYS_REGION);

  cached = {
    auth: {
      sessionSecret,
      sessionTtlMinutes: int(process.env.SESSION_TTL_MINUTES, 720),
      configured: Boolean(sessionSecret),
    },
    ingestion: {
      clientId,
      clientSecret,
      regionHost,
      cronSecret: process.env.CRON_SECRET || null,
      configured: Boolean(clientId && clientSecret && regionHost),
      flowIds: list(process.env.AVA_FLOW_IDS),
      // Bounds the session query only; reporting turns have no date filter. Overlaps the 10-minute
      // cron cadence by a wide margin on purpose: session data appears with some lag, and a window
      // matching the schedule loses whatever landed a second late. Upserts make the overlap free,
      // and the extra width is what lets ingestion recover a gap rather than lose it permanently.
      lookbackMinutes: int(process.env.INGEST_LOOKBACK_MINUTES, 240),
      maxExecutionsPerRun: int(process.env.INGEST_MAX_EXECUTIONS_PER_RUN, 200),
    },
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
  ingestionConfigured: boolean;
  databaseConfigured: boolean;
  missing: string[];
  environmentLabel: string;
  appVersion: string;
}

export function getReadiness(): ReadinessReport {
  const cfg = getServerConfig();
  const missing: string[] = [];
  if (!cfg.auth.sessionSecret) missing.push('APP_SESSION_SECRET');
  if (!cfg.ingestion.clientId) missing.push('GENESYS_INGEST_CLIENT_ID');
  if (!cfg.ingestion.clientSecret) missing.push('GENESYS_INGEST_CLIENT_SECRET');
  if (!cfg.ingestion.regionHost) missing.push('GENESYS_REGION');
  if (!cfg.ingestion.cronSecret) missing.push('CRON_SECRET');
  if (!process.env.POSTGRES_URL) missing.push('POSTGRES_URL');

  return {
    authConfigured: cfg.auth.configured,
    ingestionConfigured: cfg.ingestion.configured,
    databaseConfigured: Boolean(process.env.POSTGRES_URL),
    missing,
    environmentLabel: cfg.environmentLabel,
    appVersion: cfg.appVersion,
  };
}
