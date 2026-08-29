import 'server-only';

import type { NextRequest } from 'next/server';
import { AppError } from '@/lib/errors';
import { getServerConfig } from '../config';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from './cookies';
import {
  randomToken,
  signSession,
  timingSafeEqual,
  verifySession,
  type SessionPayload,
} from './session-core';

/**
 * Route-handler authentication, CSRF and cron guards. The signed app session is created only
 * after Genesys Cloud completes the Authorization Code + PKCE callback.
 */

/** Mint a signed app session token for the authenticated Genesys user. */
export async function issueSessionToken(username: string): Promise<string> {
  const cfg = getServerConfig();
  if (!cfg.auth.sessionSecret)
    throw new AppError('APP_UNAUTHENTICATED', { detail: 'no session secret' });
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: username,
    iat: now,
    exp: now + cfg.auth.sessionTtlMinutes * 60,
  };
  return signSession(payload, cfg.auth.sessionSecret);
}

/** A fresh CSRF token to pair with a new session. */
export function issueCsrfToken(): string {
  return randomToken(32);
}

/** Read and verify the session from a request, or null. */
export async function getSession(req: NextRequest): Promise<SessionPayload | null> {
  const cfg = getServerConfig();
  if (!cfg.auth.sessionSecret) return null;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return verifySession(token, cfg.auth.sessionSecret);
}

/** Require a valid session; throws APP_UNAUTHENTICATED otherwise. */
export async function requireAuth(req: NextRequest): Promise<SessionPayload> {
  const session = await getSession(req);
  if (!session) throw new AppError('APP_UNAUTHENTICATED');
  return session;
}

/**
 * CSRF protection for mutating, cookie-authenticated routes: validate the Origin header against
 * the request host AND a double-submit token (the `x-csrf-token` header must equal the
 * non-HttpOnly CSRF cookie).
 */
export function requireCsrf(req: NextRequest): void {
  const origin = req.headers.get('origin');
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new AppError('APP_CSRF_REJECTED', { detail: 'unparseable origin' });
    }
    const host = req.headers.get('host');
    if (host && originHost !== host) {
      throw new AppError('APP_CSRF_REJECTED', { detail: 'origin/host mismatch' });
    }
  }
  const headerToken = req.headers.get(CSRF_HEADER);
  const cookieToken = req.cookies.get(CSRF_COOKIE)?.value;
  if (!headerToken || !cookieToken || !timingSafeEqual(headerToken, cookieToken)) {
    throw new AppError('APP_CSRF_REJECTED', { detail: 'csrf token mismatch' });
  }
}

/**
 * Cron routes are not reachable by a user session, so they carry their own bearer secret. Vercel
 * Cron sends `Authorization: Bearer $CRON_SECRET`. Compared in constant time because this is the
 * only thing standing between the public internet and the org's whole Genesys API budget.
 */
export function requireCronSecret(req: NextRequest): void {
  const cfg = getServerConfig();
  if (!cfg.ingestion.cronSecret) {
    throw new AppError('INGEST_NOT_AUTHORIZED', { detail: 'CRON_SECRET is not configured' });
  }
  const provided = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${cfg.ingestion.cronSecret}`;
  if (!timingSafeEqual(provided, expected)) {
    throw new AppError('INGEST_NOT_AUTHORIZED', { detail: 'bad or missing cron secret' });
  }
}
