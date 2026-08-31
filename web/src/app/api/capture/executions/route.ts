import { NextResponse, type NextRequest } from 'next/server';
import { AppError, toAppError } from '@/lib/errors';
import { requireAuth, requireCsrf } from '@/server/auth/guards';
import { captureExecutions } from '@/server/capture';
import { validateCaptureRequest } from '@/server/capture/helpers';
import { logger } from '@/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Capture execution histories for event-supplied triples using the signed-in user's Genesys token.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAuth(req);
    requireCsrf(req);

    const body = await req.json().catch(() => null);
    const parsed = validateCaptureRequest(body);
    if (!parsed.ok) {
      throw new AppError('APP_BAD_REQUEST', { detail: parsed.error });
    }

    const result = await captureExecutions(parsed.triples);
    logger.info('capture.executions.finished', {
      ok: result.ok,
      apiCalls: result.apiCalls,
      metrics: result.metrics,
    });

    return NextResponse.json(result);
  } catch (cause) {
    const error = toAppError(cause);
    logger.warn('capture.executions.rejected', {
      code: error.code,
      detail: error.detail,
    });
    return NextResponse.json(error.toClientJSON(), { status: error.httpStatus });
  }
}
