import { NextResponse, type NextRequest } from 'next/server';
import { toAppError } from '@/lib/errors';
import { requireCronSecret } from '@/server/auth/guards';
import { runFidelityPass } from '@/server/ingest';
import { logger } from '@/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Full execution history for conversations triage has already seen.
 *
 * Scheduled five minutes after triage so it always works from a fresh worklist rather than
 * discovering conversations itself, which would cost API calls to learn what triage already knows.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireCronSecret(req);
  } catch (err) {
    const appError = toAppError(err);
    return NextResponse.json(appError.toClientJSON(), { status: appError.httpStatus });
  }

  const result = await runFidelityPass();
  logger.info('cron.fidelity.finished', {
    ok: result.ok,
    apiCalls: result.apiCalls,
    summary: result.summary,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
