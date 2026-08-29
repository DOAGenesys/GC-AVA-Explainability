/**
 * Cookie names and attribute builders. Pure (no env, no server-only) so they are usable from both
 * middleware and route handlers.
 */
export const SESSION_COOKIE = 'avaobs_session';
export const CSRF_COOKIE = 'avaobs_csrf';
export const GENESYS_AUTH_COOKIE = 'avaobs_genesys_auth';
export const OAUTH_STATE_COOKIE = 'avaobs_oauth_state';
export const CSRF_HEADER = 'x-csrf-token';

export interface CookieOptions {
  httpOnly: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  secure: boolean;
  path: string;
  maxAge: number;
}

/**
 * Session cookie: HttpOnly and SameSite=Lax so OAuth's cross-site callback can set the cookie and
 * immediately redirect into the app.
 */
export function sessionCookieOptions(maxAgeSeconds: number, secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: maxAgeSeconds };
}

/**
 * CSRF cookie: readable by JS (NOT HttpOnly) for the double-submit pattern. Same-origin policy
 * prevents an attacker reading it; mutating routes also require a same-origin request plus a
 * matching x-csrf-token header.
 */
export function csrfCookieOptions(maxAgeSeconds: number, secure: boolean): CookieOptions {
  return { httpOnly: false, sameSite: 'lax', secure, path: '/', maxAge: maxAgeSeconds };
}

/** Encrypted Genesys token session; only server route handlers can read it. */
export function genesysAuthCookieOptions(maxAgeSeconds: number, secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: maxAgeSeconds };
}

/** OAuth callback comes from Genesys, so the temporary state cookie must be Lax. */
export function oauthStateCookieOptions(maxAgeSeconds: number, secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: maxAgeSeconds };
}

/** Expired cookie used to clear a value on logout. */
export function clearedCookieOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: 0 };
}
