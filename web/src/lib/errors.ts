/**
 * Stable error codes and their user-facing presentation. Codes are safe to log; user messages
 * never contain secrets, tokens, URLs or raw provider responses.
 */

export type ErrorSeverity = 'info' | 'warning' | 'error';

export const ERROR_CODES = [
  // App access / auth
  'APP_UNAUTHENTICATED',
  'APP_CSRF_REJECTED',
  'APP_BAD_REQUEST',
  'APP_NOT_FOUND',
  // Genesys auth / config
  'GENESYS_NOT_CONFIGURED',
  'GENESYS_AUTH_FAILED',
  'GENESYS_PERMISSION_DENIED',
  // Ingestion
  'INGEST_NOT_AUTHORIZED',
  'INGEST_FAILED',
  'JOBS_BATCH_REJECTED',
  'NO_EXECUTION_HISTORY',
  // Infra
  'DATABASE_NOT_CONFIGURED',
  'RATE_LIMITED',
  'GENESYS_UPSTREAM_ERROR',
  'UNKNOWN_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorMeta {
  code: ErrorCode;
  severity: ErrorSeverity;
  retryable: boolean;
  message: string;
  nextAction: string;
  httpStatus: number;
}

export const ERROR_META: Record<ErrorCode, ErrorMeta> = {
  APP_UNAUTHENTICATED: {
    code: 'APP_UNAUTHENTICATED',
    severity: 'error',
    retryable: false,
    message: 'Your session is not authenticated.',
    nextAction: 'Sign in again to continue.',
    httpStatus: 401,
  },
  APP_CSRF_REJECTED: {
    code: 'APP_CSRF_REJECTED',
    severity: 'error',
    retryable: false,
    message: 'The request failed a cross-site request forgery check.',
    nextAction: 'Reload the page and try again.',
    httpStatus: 403,
  },
  APP_BAD_REQUEST: {
    code: 'APP_BAD_REQUEST',
    severity: 'error',
    retryable: false,
    message: 'The request was malformed or failed validation.',
    nextAction: 'Correct the input and try again.',
    httpStatus: 400,
  },
  APP_NOT_FOUND: {
    code: 'APP_NOT_FOUND',
    severity: 'error',
    retryable: false,
    message: 'Nothing was found for this identifier.',
    nextAction: 'Check the identifier, or wait for the next ingestion pass.',
    httpStatus: 404,
  },
  GENESYS_NOT_CONFIGURED: {
    code: 'GENESYS_NOT_CONFIGURED',
    severity: 'error',
    retryable: false,
    message: 'Genesys sign-in is not connected.',
    nextAction: 'Sign in with Genesys Cloud again.',
    httpStatus: 503,
  },
  GENESYS_AUTH_FAILED: {
    code: 'GENESYS_AUTH_FAILED',
    severity: 'error',
    retryable: false,
    message: 'Genesys authentication failed.',
    nextAction: 'Sign in again and verify the region and Client ID.',
    httpStatus: 502,
  },
  GENESYS_PERMISSION_DENIED: {
    code: 'GENESYS_PERMISSION_DENIED',
    severity: 'error',
    retryable: false,
    message: 'Your Genesys user does not have permission for this operation.',
    nextAction:
      'Ask an administrator for architect:flow:view, architect:flowInstance:view and analytics:botFlowReportingTurn:view.',
    httpStatus: 403,
  },
  INGEST_NOT_AUTHORIZED: {
    code: 'INGEST_NOT_AUTHORIZED',
    severity: 'error',
    retryable: false,
    message: 'This ingestion endpoint requires the cron secret.',
    nextAction: 'Only Vercel Cron may invoke this route.',
    httpStatus: 401,
  },
  INGEST_FAILED: {
    code: 'INGEST_FAILED',
    severity: 'error',
    retryable: true,
    message: 'An ingestion pass failed.',
    nextAction: 'The next scheduled pass will retry from the last watermark.',
    httpStatus: 500,
  },
  JOBS_BATCH_REJECTED: {
    code: 'JOBS_BATCH_REJECTED',
    severity: 'warning',
    retryable: true,
    message: 'The execution-history job was rejected as a whole.',
    nextAction: 'The batch is bisected automatically to isolate the offending execution.',
    httpStatus: 502,
  },
  NO_EXECUTION_HISTORY: {
    code: 'NO_EXECUTION_HISTORY',
    severity: 'info',
    retryable: false,
    message: 'Genesys holds no execution history for this execution.',
    nextAction: 'Use the turn-level analytics view, which covers executions that never terminated.',
    httpStatus: 404,
  },
  DATABASE_NOT_CONFIGURED: {
    code: 'DATABASE_NOT_CONFIGURED',
    severity: 'error',
    retryable: false,
    message: 'No Postgres connection is configured.',
    nextAction: 'Attach a Vercel Postgres store so POSTGRES_URL is present.',
    httpStatus: 503,
  },
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    severity: 'warning',
    retryable: true,
    message: 'Genesys rate-limited the request.',
    nextAction: 'The app retries automatically using the response Retry-After.',
    httpStatus: 429,
  },
  GENESYS_UPSTREAM_ERROR: {
    code: 'GENESYS_UPSTREAM_ERROR',
    severity: 'error',
    retryable: true,
    message: 'Genesys returned a server error.',
    nextAction: 'Safe operations are retried automatically.',
    httpStatus: 502,
  },
  UNKNOWN_ERROR: {
    code: 'UNKNOWN_ERROR',
    severity: 'error',
    retryable: false,
    message: 'An unexpected error occurred.',
    nextAction: 'Check the ingestion log and retry.',
    httpStatus: 500,
  },
};

/**
 * A redaction-safe application error. `detail` is for server logs only and must already be
 * redacted by the caller; it is never sent to the browser.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly detail?: string;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, options?: { detail?: string; cause?: unknown }) {
    const meta = ERROR_META[code];
    super(meta.message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = meta.httpStatus;
    this.detail = options?.detail;
    this.cause = options?.cause;
  }

  /** The non-secret payload safe to return to the browser. */
  toClientJSON(): { error: { code: ErrorCode; message: string; nextAction: string } } {
    const meta = ERROR_META[this.code];
    return { error: { code: this.code, message: meta.message, nextAction: meta.nextAction } };
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  return new AppError('UNKNOWN_ERROR', { cause: err });
}
