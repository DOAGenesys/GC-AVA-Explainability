import { NextResponse, type NextRequest } from 'next/server';
import { AppError, toAppError } from '@/lib/errors';
import { buildNotificationTopics } from '@/lib/notification-events';
import { requireAuth, requireCsrf } from '@/server/auth/guards';
import { createNotificationChannel } from '@/server/genesys/notifications';
import { logger } from '@/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface StartRequest {
  flowIds?: unknown;
}

/**
 * Create the authenticated channel and hand its opaque WebSocket URI to the browser.
 *
 * The browser never sees the OAuth token. Genesys authenticates the channel when it is created and
 * the returned connect URI is sufficient for the one active WebSocket allowed on that channel.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAuth(req);
    requireCsrf(req);

    const body = (await req.json().catch(() => null)) as StartRequest | null;
    const built = buildNotificationTopics({
      flowIds: Array.isArray(body?.flowIds)
        ? body.flowIds.filter((flowId): flowId is string => typeof flowId === 'string')
        : [],
    });

    if (built.errors.length > 0) {
      throw new AppError('APP_BAD_REQUEST', { detail: built.errors.join(' ') });
    }

    const channel = await createNotificationChannel();
    logger.info('notifications.channel.created', {
      channelId: channel.id,
      topics: built.topics,
      expires: channel.expires,
      apiCalls: channel.apiCalls,
    });

    return NextResponse.json({
      channelId: channel.id,
      connectUri: channel.connectUri,
      expires: channel.expires,
      topics: built.topics,
    });
  } catch (cause) {
    const error = toAppError(cause);
    logger.warn('notifications.channel.rejected', {
      code: error.code,
      detail: error.detail,
    });
    return NextResponse.json(error.toClientJSON(), { status: error.httpStatus });
  }
}
