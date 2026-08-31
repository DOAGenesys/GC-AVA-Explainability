import { NextResponse, type NextRequest } from 'next/server';
import { toAppError } from '@/lib/errors';
import { requireCronSecret } from '@/server/auth/guards';
import { runRegistryPass } from '@/server/ingest';
import { logger } from '@/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Refresh the AVA flow registry. Cheap, and the guard against flow-flag drift. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireCronSecret(req);
  } catch (err) {
    const appError = toAppError(err);
    return NextResponse.json(appError.toClientJSON(), { status: appError.httpStatus });
  }

  const result = await runRegistryPass();
  logger.info('cron.registry.finished', {
    ok: result.ok,
    apiCalls: result.apiCalls,
    summary: result.summary,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
