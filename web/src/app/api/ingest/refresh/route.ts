import { NextResponse, type NextRequest } from 'next/server';
import { AppError, toAppError } from '@/lib/errors';
import { requireAuth, requireCsrf } from '@/server/auth/guards';
import { runFidelityPass, runTriagePass } from '@/server/ingest';
import { logger } from '@/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type RefreshPass = 'triage' | 'fidelity';

function isRefreshPass(value: unknown): value is RefreshPass {
  return value === 'triage' || value === 'fidelity';
}

/**
 * Run one ingestion pass on demand for a signed-in dashboard user.
 *
 * This remains separate from the cron routes: those accept only CRON_SECRET, while a browser
 * mutation must prove both a valid app session and a same-origin CSRF token.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAuth(req);
    requireCsrf(req);

    const body = (await req.json().catch(() => null)) as { pass?: unknown } | null;
    if (!isRefreshPass(body?.pass)) {
      throw new AppError('APP_BAD_REQUEST', { detail: 'refresh pass is missing or invalid' });
    }

    const result = body.pass === 'triage' ? await runTriagePass() : await runFidelityPass();
    logger.info('manual_refresh.finished', {
      pass: body.pass,
      ok: result.ok,
      apiCalls: result.apiCalls,
      summary: result.summary,
    });

    if (!result.ok) {
      const error = new AppError('INGEST_FAILED', {
        detail: `${body.pass}: ${String(result.summary.error ?? 'unknown')}`,
      });
      return NextResponse.json(error.toClientJSON(), { status: error.httpStatus });
    }

    return NextResponse.json({ pass: body.pass, ...result });
  } catch (cause) {
    const error = toAppError(cause);
    logger.warn('manual_refresh.rejected', {
      code: error.code,
      detail: error.detail,
    });
    return NextResponse.json(error.toClientJSON(), { status: error.httpStatus });
  }
}
