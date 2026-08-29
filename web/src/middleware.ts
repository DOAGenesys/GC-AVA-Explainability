import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/server/auth/cookies';
import { verifySession } from '@/server/auth/session-core';

/**
 * Edge middleware enforcing a strict, nonce-based Content-Security-Policy on every response and
 * the signed app-session access gate. No page or API route is reachable without a valid session,
 * except the login flow, the liveness probe, and the cron routes.
 *
 * Cron routes are excluded here rather than left unauthenticated: they are called by Vercel Cron,
 * which sends a bearer secret and no cookie, so a session check would reject every legitimate
 * invocation. Each cron route validates that secret itself before doing any work.
 *
 * Kept dependency-light and `server-only`-free so it runs in the edge runtime.
 */

const PUBLIC_PATHS = new Set<string>([
  '/login',
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/logout',
  '/api/health',
]);

function buildCsp(nonce: string, isProd: boolean): string {
  const scriptSrc = [`'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`];
  if (!isProd) scriptSrc.push(`'unsafe-eval'`); // React Fast Refresh in dev only.

  const directives: Record<string, string[]> = {
    'default-src': [`'self'`],
    'script-src': scriptSrc,
    // Recharts renders inline style attributes on SVG nodes, which cannot carry a nonce.
    'style-src': [`'self'`, `'unsafe-inline'`],
    'img-src': [`'self'`, 'data:', 'blob:'],
    // next/font self-hosts Roboto at build time, so no external font origin is needed.
    'font-src': [`'self'`],
    'connect-src': [`'self'`],
    'worker-src': [`'self'`, 'blob:'],
    'object-src': [`'none'`],
    'base-uri': [`'self'`],
    'form-action': [`'self'`],
    'frame-ancestors': [`'none'`],
  };
  let csp = Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
  if (isProd) csp += '; upgrade-insecure-requests';
  return csp;
}

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || pathname.startsWith('/api/cron/');
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const isProd = process.env.NODE_ENV === 'production';
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const csp = buildCsp(nonce, isProd);
  const { pathname, search } = req.nextUrl;

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const applyResponseHeaders = (res: NextResponse): NextResponse => {
    res.headers.set('content-security-policy', csp);
    return res;
  };

  if (isPublic(pathname)) {
    return applyResponseHeaders(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  const secret = process.env.APP_SESSION_SECRET;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = secret ? await verifySession(token, secret) : null;

  if (!session) {
    if (pathname.startsWith('/api/')) {
      return applyResponseHeaders(
        NextResponse.json(
          {
            error: {
              code: 'APP_UNAUTHENTICATED',
              message: 'Authentication required.',
              nextAction: 'Sign in to continue.',
            },
          },
          { status: 401 },
        ),
      );
    }
    const loginUrl = new URL('/login', req.nextUrl);
    loginUrl.searchParams.set('next', pathname + search);
    return applyResponseHeaders(NextResponse.redirect(loginUrl));
  }

  return applyResponseHeaders(NextResponse.next({ request: { headers: requestHeaders } }));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|images/).*)'],
};
