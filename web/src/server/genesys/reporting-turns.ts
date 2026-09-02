import 'server-only';

import { AppError, isAppError } from '@/lib/errors';
import {
  DIVISION_REPORTING_TURNS_ENDPOINT,
  REPORTING_TURNS_MAX_PAGES,
  REPORTING_TURNS_PAGE_SIZE,
  reportingTurnsNextPath,
  type ReportingTurnEntity,
  type ReportingTurnsQuery,
  type ReportingTurnsResponse,
} from '@/lib/reporting-turns';
import { genesysRequest, newBudget, type ApiResponse, type Identity } from './http';

interface GenesysReportingTurnsPage {
  entities?: ReportingTurnEntity[];
  nextUri?: string;
}

const USER_IDENTITY: Identity = { kind: 'user' };

/**
 * Fetch a bounded segment of division-aware Reporting Turns.
 *
 * Each segment follows Genesys' opaque, already-encoded nextUri directly. The browser can request
 * subsequent segments until `complete` is true without ever decoding and re-encoding that cursor.
 */
export async function fetchDivisionReportingTurns(
  query: ReportingTurnsQuery,
): Promise<ReportingTurnsResponse> {
  const budget = newBudget();
  const entities: ReportingTurnEntity[] = [];
  const endpoint = DIVISION_REPORTING_TURNS_ENDPOINT.replace('{botFlowId}', query.botFlowId);
  let path = query.continuationUri ?? endpoint;
  let nextUri: string | null = null;
  let complete = false;
  let pages = 0;

  for (let page = 0; page < REPORTING_TURNS_MAX_PAGES; page += 1) {
    const firstPage = page === 0 && !query.continuationUri;
    let response: ApiResponse<GenesysReportingTurnsPage>;
    try {
      response = await genesysRequest<GenesysReportingTurnsPage>({
        path,
        query: firstPage
          ? {
              interval: query.interval,
              pageSize: REPORTING_TURNS_PAGE_SIZE,
              actionId: query.actionId,
              sessionId: query.sessionId,
              language: query.language,
              askActionResults: query.askActionResults?.join(','),
            }
          : undefined,
        identity: USER_IDENTITY,
        budget,
        timeoutMs: 30_000,
      });
    } catch (cause) {
      if (isAppError(cause) && cause.code === 'GENESYS_PERMISSION_DENIED') {
        throw new AppError('GENESYS_REPORTING_PERMISSION_DENIED', { cause });
      }
      throw cause;
    }

    if (!response.ok || !response.data) {
      if (response.status === 404) {
        throw new AppError('APP_NOT_FOUND', { detail: 'bot-flow reporting turns returned 404' });
      }
      if (response.status === 429) {
        throw new AppError('RATE_LIMITED', { detail: 'bot-flow reporting turns returned 429' });
      }
      throw new AppError('GENESYS_UPSTREAM_ERROR', {
        detail: `division reporting turns returned ${response.status || 'no response'}`,
      });
    }

    pages += 1;
    entities.push(...(response.data.entities ?? []));
    nextUri = response.data.nextUri ?? null;
    if (!nextUri) {
      complete = true;
      break;
    }

    const safePath = reportingTurnsNextPath(nextUri, query.botFlowId);
    if (!safePath) {
      throw new AppError('GENESYS_UPSTREAM_ERROR', {
        detail: 'reporting turns returned an invalid continuation URI',
      });
    }
    path = safePath;
  }

  return {
    entities,
    pages,
    apiCalls: budget.calls,
    sessions: new Set(entities.map((turn) => turn.sessionId).filter(Boolean)).size,
    complete,
    nextUri: complete ? null : nextUri,
    fetchedAt: new Date().toISOString(),
  };
}
