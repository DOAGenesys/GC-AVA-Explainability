import { NextResponse, type NextRequest } from 'next/server';
import { toAppError } from '@/lib/errors';
import { getServerConfig } from '@/server/config';
import {
  authErrorRedirect,
  buildAuthorizeRedirect,
  setOAuthStateCookie,
} from '@/server/genesys/oauth';
import { logger } from '@/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Start Authorization Code + PKCE. The PKCE verifier leaves here only inside an encrypted cookie. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const { url, stateCookieValue } = await buildAuthorizeRedirect(req);
    const cfg = getServerConfig();
    const secure = req.nextUrl.protocol === 'https:' || cfg.environmentLabel === 'production';
    const res = NextResponse.redirect(url);
    setOAuthStateCookie(res, stateCookieValue, secure);
    return res;
  } catch (err) {
    const appError = toAppError(err);
    logger.warn('auth.login.rejected', { code: appError.code, detail: appError.detail });
    return NextResponse.redirect(authErrorRedirect(req, appError.code));
  }
}
