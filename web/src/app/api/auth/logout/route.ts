import { NextResponse, type NextRequest } from 'next/server';
import { getServerConfig } from '@/server/config';
import { clearGenesysAuthCookies } from '@/server/genesys/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Sign out. Deliberately reachable without CSRF: the only effect is clearing this browser's own
 * cookies, so a forged request can do nothing an attacker benefits from, while requiring a token
 * would leave users stranded once a session had already gone stale.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const cfg = getServerConfig();
  const secure = req.nextUrl.protocol === 'https:' || cfg.environmentLabel === 'production';
  const res = NextResponse.redirect(new URL('/login', req.nextUrl));
  clearGenesysAuthCookies(res, secure);
  return res;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return POST(req);
}
