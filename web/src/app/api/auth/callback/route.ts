import { NextResponse, type NextRequest } from 'next/server';
import { toAppError } from '@/lib/errors';
import {
  authErrorRedirect,
  completeAuthorizationCodeLogin,
  successRedirect,
} from '@/server/genesys/oauth';
import { logger } from '@/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * OAuth callback. The redirect target is computed first and the cookies are attached to that
 * response, because cookies set on a response the browser never receives are silently lost.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = req.nextUrl.searchParams.get('error');
  if (denied) {
    logger.warn('auth.callback.denied', { reason: denied });
    return NextResponse.redirect(authErrorRedirect(req, 'GENESYS_AUTH_FAILED'));
  }

  const carrier = NextResponse.next();
  try {
    const next = await completeAuthorizationCodeLogin(req, carrier);
    const res = NextResponse.redirect(successRedirect(req, next));
    for (const cookie of carrier.cookies.getAll()) res.cookies.set(cookie);
    return res;
  } catch (err) {
    const appError = toAppError(err);
    logger.warn('auth.callback.failed', { code: appError.code, detail: appError.detail });
    return NextResponse.redirect(authErrorRedirect(req, appError.code));
  }
}
