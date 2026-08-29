/**
 * Stateless signed-session primitives (HMAC-SHA-256 over a compact payload).
 *
 * Pure and dependency-free (no `server-only`, no env access) so it can run in BOTH the edge
 * middleware and Node route handlers. The signing secret is always passed in by the caller. There
 * is no server-side session store - the cookie is the session, integrity-protected by the HMAC.
 */

export interface SessionPayload {
  /** Subject - the authenticated Genesys user's display name. */
  sub: string;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(data) as BufferSource));
  return base64urlEncode(sig);
}

/** Sign an arbitrary JSON payload into a `<payload>.<sig>` token. */
export async function signToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = base64urlEncode(utf8(JSON.stringify(payload)));
  const sig = await hmac(secret, body);
  return `${body}.${sig}`;
}

/**
 * Verify a token's signature and (if present) its `exp`, returning the decoded payload or null.
 * Does not interpret any other field.
 */
export async function verifyToken<T extends { exp?: number }>(
  token: string | undefined | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<T | null> {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(secret, body);
  if (!timingSafeEqual(sig, expected)) return null;
  let payload: T;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(body))) as T;
  } catch {
    return null;
  }
  if (typeof payload.exp === 'number' && payload.exp < nowSeconds) return null;
  return payload;
}

/** Sign a session payload into a `<payload>.<sig>` token. */
export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  return signToken(payload as unknown as Record<string, unknown>, secret);
}

/** Verify a session token's signature + expiry, returning the payload or null. */
export async function verifySession(
  token: string | undefined | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SessionPayload | null> {
  const payload = await verifyToken<SessionPayload & { exp: number }>(token, secret, nowSeconds);
  if (!payload) return null;
  if (typeof payload.exp !== 'number' || payload.exp < nowSeconds) return null;
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
  return payload;
}

/** Generate a random URL-safe token (for CSRF). */
export function randomToken(bytes = 32): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}
