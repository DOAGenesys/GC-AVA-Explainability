import 'server-only';

import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import type { NextRequest, NextResponse } from 'next/server';
import { AppError } from '@/lib/errors';
import { getServerConfig, normalizeRegionHost } from '../config';
import { decryptJson, encryptJson } from '../auth/secure-cookie';
import { issueCsrfToken, issueSessionToken } from '../auth/guards';
import {
  CSRF_COOKIE,
  GENESYS_AUTH_COOKIE,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  csrfCookieOptions,
  genesysAuthCookieOptions,
  oauthStateCookieOptions,
  sessionCookieOptions,
} from '../auth/cookies';
import { logger } from '../logger';

/**
 * Genesys OAuth helpers for both identities the app uses.
 *
 *   - Authorization Code + PKCE for the signed-in human. Access and refresh tokens live only
 *     inside an encrypted HttpOnly cookie; nothing is persisted server-side.
 *   - Client credentials for the cron ingestion routes, cached in module scope for the lifetime
 *     of the serverless instance.
 */

const TOKEN_PATH = '/oauth/token';

export interface GenesysUserProfile {
  id?: string;
  name?: string;
  email?: string;
  username?: string;
}

export interface GenesysAuthContext {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  clientId: string;
  regionHost: string;
  user?: GenesysUserProfile;
}

interface OAuthState {
  state: string;
  verifier: string;
  clientId: string;
  regionHost: string;
  next: string;
  createdAtMs: number;
}

export interface AccessTokenResult {
  accessToken: string;
  regionHost: string;
  authContext: GenesysAuthContext;
  refreshed: boolean;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
}

/** Derive the login host (login.<region>) from the API host (api.<region>). */
export function deriveLoginHost(apiHost: string): string {
  if (apiHost.startsWith('api.')) return `login.${apiHost.slice(4)}`;
  return `login.${apiHost}`;
}

function getPublicOrigin(req: NextRequest): string {
  const proto =
    req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
    req.nextUrl.protocol.replace(/:$/, '');
  const host =
    req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    req.headers.get('host') ||
    req.nextUrl.host;
  return `${proto}://${host}`;
}

function redirectUri(req: NextRequest): string {
  return `${getPublicOrigin(req)}/api/auth/callback`;
}

function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function getSecret(): string {
  const cfg = getServerConfig();
  if (!cfg.auth.sessionSecret) throw new AppError('APP_UNAUTHENTICATED');
  return cfg.auth.sessionSecret;
}

function createPkceVerifier(): string {
  return crypto.randomBytes(64).toString('base64url').slice(0, 96);
}

function createPkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function randomBase64Url(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function encodeState(state: OAuthState): string {
  return encryptJson(state, getSecret());
}

function decodeState(value: string): OAuthState {
  return decryptJson<OAuthState>(value, getSecret());
}

export function encryptGenesysAuthContext(context: GenesysAuthContext): string {
  return encryptJson(context, getSecret());
}

export function decryptGenesysAuthContext(value: string): GenesysAuthContext {
  return decryptJson<GenesysAuthContext>(value, getSecret());
}

export async function getGenesysAuthContextFromCookie(): Promise<GenesysAuthContext | null> {
  const store = await cookies();
  const value = store.get(GENESYS_AUTH_COOKIE)?.value;
  if (!value) return null;
  try {
    return decryptGenesysAuthContext(value);
  } catch {
    return null;
  }
}

function displayName(user: GenesysUserProfile | undefined): string {
  return user?.name || user?.email || user?.username || user?.id || 'Genesys user';
}

function isTokenResponse(value: unknown): value is TokenResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.access_token === 'string' && typeof v.expires_in === 'number';
}

async function postToken(regionHost: string, body: URLSearchParams): Promise<TokenResponse> {
  const url = `https://${deriveLoginHost(regionHost)}${TOKEN_PATH}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (err) {
    logger.error('genesys.oauth.network_error', { name: (err as Error)?.name });
    throw new AppError('GENESYS_AUTH_FAILED', { cause: err });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    logger.error('genesys.oauth.failed', { status: res.status });
    throw new AppError('GENESYS_AUTH_FAILED', { detail: `token endpoint status ${res.status}` });
  }

  const parsed: unknown = await res.json().catch(() => null);
  if (!isTokenResponse(parsed)) {
    throw new AppError('GENESYS_AUTH_FAILED', { detail: 'unexpected token response shape' });
  }
  return parsed;
}

async function fetchGenesysUser(
  regionHost: string,
  accessToken: string,
): Promise<GenesysUserProfile> {
  try {
    const res = await fetch(`https://${regionHost}/api/v2/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return {};
    const json = (await res.json()) as GenesysUserProfile;
    return json && typeof json === 'object' ? json : {};
  } catch {
    return {};
  }
}

async function refreshAuthContext(context: GenesysAuthContext): Promise<GenesysAuthContext> {
  if (!context.refreshToken) throw new AppError('GENESYS_AUTH_FAILED');
  const token = await postToken(
    context.regionHost,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: context.refreshToken,
      client_id: context.clientId,
    }),
  );
  return {
    ...context,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? context.refreshToken,
    expiresAtMs: Date.now() + token.expires_in * 1000,
  };
}

async function persistGenesysAuthCookie(context: GenesysAuthContext): Promise<void> {
  const store = await cookies();
  const cfg = getServerConfig();
  store.set(
    GENESYS_AUTH_COOKIE,
    encryptGenesysAuthContext(context),
    genesysAuthCookieOptions(
      cfg.auth.sessionTtlMinutes * 60,
      cfg.environmentLabel === 'production',
    ),
  );
}

export async function getAccessToken(
  context?: GenesysAuthContext,
  options: { forceRefresh?: boolean } = {},
): Promise<AccessTokenResult> {
  let authContext = context ?? (await getGenesysAuthContextFromCookie());
  if (!authContext) throw new AppError('GENESYS_NOT_CONFIGURED');

  const shouldRefresh = options.forceRefresh || authContext.expiresAtMs - Date.now() <= 60_000;
  if (!shouldRefresh) {
    return {
      accessToken: authContext.accessToken,
      regionHost: authContext.regionHost,
      authContext,
      refreshed: false,
    };
  }

  authContext = await refreshAuthContext(authContext);
  if (!context) await persistGenesysAuthCookie(authContext);
  return {
    accessToken: authContext.accessToken,
    regionHost: authContext.regionHost,
    authContext,
    refreshed: true,
  };
}

// --------------------------------------------------------------------- ingestion identity

let ingestionToken: { value: string; expiresAtMs: number } | null = null;

/**
 * Client-credentials token for the cron routes, cached for the instance's lifetime.
 *
 * Ingestion cannot use a user's PKCE cookie: cron has no cookie jar, and an org-wide archive that
 * depended on one person's session would break the day that person's token was revoked.
 */
export async function getIngestionAccessToken(options: { forceRefresh?: boolean } = {}): Promise<{
  accessToken: string;
  regionHost: string;
}> {
  const cfg = getServerConfig();
  if (!cfg.ingestion.configured || !cfg.ingestion.regionHost) {
    throw new AppError('GENESYS_NOT_CONFIGURED', { detail: 'ingestion credentials missing' });
  }

  if (!options.forceRefresh && ingestionToken && Date.now() < ingestionToken.expiresAtMs) {
    return { accessToken: ingestionToken.value, regionHost: cfg.ingestion.regionHost };
  }

  const token = await postToken(
    cfg.ingestion.regionHost,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.ingestion.clientId ?? '',
      client_secret: cfg.ingestion.clientSecret ?? '',
    }),
  );

  // 60s of margin so a token cannot expire between submitting a job and polling it.
  ingestionToken = {
    value: token.access_token,
    expiresAtMs: Date.now() + token.expires_in * 1000 - 60_000,
  };
  return { accessToken: token.access_token, regionHost: cfg.ingestion.regionHost };
}

// --------------------------------------------------------------------- interactive login

export async function buildAuthorizeRedirect(req: NextRequest): Promise<{
  url: string;
  stateCookieValue: string;
}> {
  const clientId = req.nextUrl.searchParams.get('clientId')?.trim() || '';
  const regionInput = req.nextUrl.searchParams.get('region')?.trim() || '';
  if (!clientId || !regionInput) throw new AppError('APP_BAD_REQUEST');

  const regionHost = normalizeRegionHost(regionInput);
  if (!regionHost) throw new AppError('APP_BAD_REQUEST', { detail: 'invalid Genesys region' });

  const verifier = createPkceVerifier();
  const challenge = createPkceChallenge(verifier);
  const state = randomBase64Url(32);
  const url = new URL(`https://${deriveLoginHost(regionHost)}/oauth/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri(req));
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);

  return {
    url: url.toString(),
    stateCookieValue: encodeState({
      state,
      verifier,
      clientId,
      regionHost,
      next: safeNext(req.nextUrl.searchParams.get('next')),
      createdAtMs: Date.now(),
    }),
  };
}

export async function completeAuthorizationCodeLogin(
  req: NextRequest,
  res: NextResponse,
): Promise<string> {
  const code = req.nextUrl.searchParams.get('code');
  const returnedState = req.nextUrl.searchParams.get('state');
  const stateCookie = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!code || !returnedState || !stateCookie) throw new AppError('APP_UNAUTHENTICATED');

  let oauthState: OAuthState;
  try {
    oauthState = decodeState(stateCookie);
  } catch {
    throw new AppError('APP_UNAUTHENTICATED');
  }
  if (oauthState.state !== returnedState || Date.now() - oauthState.createdAtMs > 10 * 60 * 1000) {
    throw new AppError('APP_UNAUTHENTICATED');
  }

  const token = await postToken(
    oauthState.regionHost,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(req),
      client_id: oauthState.clientId,
      code_verifier: oauthState.verifier,
      code_challenge_method: 'S256',
    }),
  );
  const user = await fetchGenesysUser(oauthState.regionHost, token.access_token);
  const context: GenesysAuthContext = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAtMs: Date.now() + token.expires_in * 1000,
    clientId: oauthState.clientId,
    regionHost: oauthState.regionHost,
    user,
  };

  const cfg = getServerConfig();
  const secure = req.nextUrl.protocol === 'https:' || cfg.environmentLabel === 'production';
  const maxAge = cfg.auth.sessionTtlMinutes * 60;

  res.cookies.set(
    SESSION_COOKIE,
    await issueSessionToken(displayName(user)),
    sessionCookieOptions(maxAge, secure),
  );
  res.cookies.set(CSRF_COOKIE, issueCsrfToken(), csrfCookieOptions(maxAge, secure));
  res.cookies.set(
    GENESYS_AUTH_COOKIE,
    encryptGenesysAuthContext(context),
    genesysAuthCookieOptions(maxAge, secure),
  );
  res.cookies.set(OAUTH_STATE_COOKIE, '', oauthStateCookieOptions(0, secure));

  return oauthState.next;
}

export function setOAuthStateCookie(res: NextResponse, value: string, secure: boolean): void {
  res.cookies.set(OAUTH_STATE_COOKIE, value, oauthStateCookieOptions(600, secure));
}

export function clearGenesysAuthCookies(res: NextResponse, secure: boolean): void {
  res.cookies.set(GENESYS_AUTH_COOKIE, '', genesysAuthCookieOptions(0, secure));
  res.cookies.set(OAUTH_STATE_COOKIE, '', oauthStateCookieOptions(0, secure));
  res.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(0, secure));
  res.cookies.set(CSRF_COOKIE, '', csrfCookieOptions(0, secure));
}

export async function currentGenesysIdentity(): Promise<{
  username: string;
  regionHost: string;
  expiresAt: number;
} | null> {
  const context = await getGenesysAuthContextFromCookie();
  if (!context) return null;
  return {
    username: displayName(context.user),
    regionHost: context.regionHost,
    expiresAt: Math.floor(context.expiresAtMs / 1000),
  };
}

export function authErrorRedirect(req: NextRequest, code: string): URL {
  const url = new URL('/login', getPublicOrigin(req));
  url.searchParams.set('auth_error', code);
  return url;
}

export function successRedirect(req: NextRequest, next: string): URL {
  return new URL(safeNext(next), getPublicOrigin(req));
}
