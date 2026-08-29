import 'server-only';

import { AppError } from '@/lib/errors';
import { logger, redactUrl } from '../logger';
import { getAccessToken, getIngestionAccessToken, type GenesysAuthContext } from './oauth';

/**
 * Genesys Platform API transport with retry, 401 re-auth, and - the part that matters here - API
 * call accounting.
 *
 * Every call is counted into an `ApiBudget` that the caller owns and later persists. The whole
 * design of this app rests on a measured claim (10 execution ids per job, 2 calls per job, so 0.2
 * calls per execution), and a claim like that decays the moment nobody is checking it. Counting in
 * the transport means the dashboard shows the real figure from production traffic rather than the
 * figure from the day it was measured.
 */

export interface ApiBudget {
  calls: number;
  byPath: Record<string, number>;
  rateLimited: number;
  startedAtMs: number;
}

export function newBudget(): ApiBudget {
  return { calls: 0, byPath: {}, rateLimited: 0, startedAtMs: Date.now() };
}

/** Collapse ids out of a path so the per-path tally stays readable. */
function budgetKey(path: string): string {
  return path
    .split('?')[0]!
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/{id}');
}

export type Identity = { kind: 'ingestion' } | { kind: 'user'; context?: GenesysAuthContext };

export interface RequestOptions {
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  identity: Identity;
  budget: ApiBudget;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Statuses that are an expected answer rather than a failure, e.g. 404 on a missing execution. */
  expectedStatuses?: number[];
}

export interface ApiResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
  errorBody?: unknown;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, 15_000);
  const base = Math.min(1000 * 2 ** attempt, 8000);
  return base + Math.floor(Math.random() * 250);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function resolveIdentity(
  identity: Identity,
  forceRefresh: boolean,
): Promise<{ accessToken: string; regionHost: string }> {
  if (identity.kind === 'ingestion') {
    return getIngestionAccessToken({ forceRefresh });
  }
  const result = await getAccessToken(identity.context, { forceRefresh });
  return { accessToken: result.accessToken, regionHost: result.regionHost };
}

function buildUrl(regionHost: string, path: string, query?: RequestOptions['query']): string {
  const url = new URL(`https://${regionHost}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export async function genesysRequest<T>(opts: RequestOptions): Promise<ApiResponse<T>> {
  const method = opts.method ?? 'GET';
  const maxAttempts = opts.maxAttempts ?? (method === 'GET' ? 4 : 2);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const expected = new Set(opts.expectedStatuses ?? []);
  let refreshedAuth = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const auth = await resolveIdentity(opts.identity, false);
    const url = buildUrl(auth.regionHost, opts.path, opts.query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    opts.budget.calls += 1;
    const key = budgetKey(opts.path);
    opts.budget.byPath[key] = (opts.budget.byPath[key] ?? 0) + 1;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          Accept: 'application/json',
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch (err) {
      clearTimeout(timer);
      logger.warn('genesys.request.thrown', {
        method,
        url: redactUrl(url),
        attempt,
        name: (err as Error)?.name,
      });
      if (attempt < maxAttempts - 1) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return { ok: false, status: 0, data: null };
    }
    clearTimeout(timer);

    // A 401 means the request was not processed, so re-authing and retrying is safe regardless of
    // method. Kept off the retry budget so a POST with maxAttempts=2 does not lose an attempt to
    // a benign token expiry; guarded so it can only happen once.
    if (res.status === 401 && !refreshedAuth) {
      refreshedAuth = true;
      await resolveIdentity(opts.identity, true);
      attempt -= 1;
      continue;
    }

    if (res.status === 403) {
      throw new AppError('GENESYS_PERMISSION_DENIED', { detail: redactUrl(url) });
    }

    if (res.ok || expected.has(res.status)) {
      const text = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        data: text ? (safeJson(text) as T) : null,
      };
    }

    if (res.status === 429) opts.budget.rateLimited += 1;

    if (RETRYABLE.has(res.status) && attempt < maxAttempts - 1) {
      await sleep(backoffMs(attempt, parseRetryAfter(res.headers.get('retry-after'))));
      continue;
    }

    const body = await res.text().catch(() => '');
    logger.warn('genesys.request.error', {
      method,
      url: redactUrl(url),
      status: res.status,
      responseBody: body ? body.slice(0, 500) : undefined,
    });
    return { ok: false, status: res.status, data: null, errorBody: safeJson(body) ?? body };
  }

  return { ok: false, status: 0, data: null };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
