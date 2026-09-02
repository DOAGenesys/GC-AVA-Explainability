import { NextResponse, type NextRequest } from 'next/server';
import { AppError, toAppError } from '@/lib/errors';
import { validateReportingTurnsQuery } from '@/lib/reporting-turns';
import { requireAuth, requireCsrf } from '@/server/auth/guards';
import { fetchDivisionReportingTurns } from '@/server/genesys/reporting-turns';
import { logger } from '@/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAuth(req);
    requireCsrf(req);

    const body = await req.json().catch(() => null);
    const parsed = validateReportingTurnsQuery(body);
    if (!parsed.ok) throw new AppError('APP_BAD_REQUEST', { detail: parsed.error });

    const result = await fetchDivisionReportingTurns(parsed.query);
    logger.info('reporting_turns.finished', {
      botFlowId: parsed.query.botFlowId,
      pages: result.pages,
      turns: result.entities.length,
      sessions: result.sessions,
      apiCalls: result.apiCalls,
      complete: result.complete,
    });
    return NextResponse.json(result);
  } catch (cause) {
    const error = toAppError(cause);
    logger.warn('reporting_turns.failed', { code: error.code, detail: error.detail });
    return NextResponse.json(error.toClientJSON(), { status: error.httpStatus });
  }
}
