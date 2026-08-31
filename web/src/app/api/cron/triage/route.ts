import { NextResponse, type NextRequest } from 'next/server';
import { toAppError } from '@/lib/errors';
import { requireCronSecret } from '@/server/auth/guards';
import { runTriagePass } from '@/server/ingest';
import { logger } from '@/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Session outcomes and turn transcripts for every AVA flow.
 *
 * Runs on a tight cadence because the upstream retention on turn data is 10 days and this is the
 * only pass that sees conversations which never produced an execution history.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireCronSecret(req);
  } catch (err) {
    const appError = toAppError(err);
    return NextResponse.json(appError.toClientJSON(), { status: appError.httpStatus });
  }

  const result = await runTriagePass();
  // A successful pass is otherwise invisible in the logs, which makes "did it run and what did it
  // see" unanswerable without opening the database.
  logger.info('cron.triage.finished', {
    ok: result.ok,
    apiCalls: result.apiCalls,
    summary: result.summary,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
