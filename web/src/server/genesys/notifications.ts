import 'server-only';

import { AppError, isAppError } from '@/lib/errors';
import { genesysRequest, newBudget, type Identity } from './http';

export interface NotificationChannel {
  id: string;
  connectUri: string;
  expires: string | null;
  apiCalls: number;
}

interface ChannelResponse {
  id?: string;
  connectUri?: string;
  expires?: string;
}

/**
 * Create a short-lived Genesys WebSocket channel for the signed-in user.
 *
 * Topic subscription itself is sent over the socket by the browser. Besides avoiding a second
 * Platform API call, this keeps the channel creation and subscription lifecycle in the component
 * that owns the connection.
 */
export async function createNotificationChannel(): Promise<NotificationChannel> {
  const identity: Identity = { kind: 'user' };
  const budget = newBudget();

  try {
    const response = await genesysRequest<ChannelResponse>({
      path: '/api/v2/notifications/channels',
      method: 'POST',
      identity,
      budget,
      maxAttempts: 1,
      timeoutMs: 15_000,
    });

    if (!response.ok || !response.data?.id || !response.data.connectUri) {
      throw new AppError('GENESYS_UPSTREAM_ERROR', {
        detail: `notification channel create returned ${response.status}`,
      });
    }

    return {
      id: response.data.id,
      connectUri: response.data.connectUri,
      expires: response.data.expires ?? null,
      apiCalls: budget.calls,
    };
  } catch (cause) {
    if (isAppError(cause) && cause.code === 'GENESYS_PERMISSION_DENIED') {
      throw new AppError('GENESYS_NOTIFICATION_PERMISSION_DENIED', { cause });
    }
    throw cause;
  }
}
