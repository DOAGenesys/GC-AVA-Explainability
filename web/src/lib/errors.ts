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
  'GENESYS_NOTIFICATION_PERMISSION_DENIED',
  // Capture
  'JOBS_BATCH_REJECTED',
  'NO_EXECUTION_HISTORY',
  // Infra
  'DATABASE_NOT_CONFIGURED',
  'DATABASE_SCHEMA_MISSING',
  'DATABASE_UNREACHABLE',
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
    nextAction: 'Check the identifier or start a live capture for the relevant flow.',
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
    nextAction: 'Ask an administrator for Architect Flow Instance View access.',
    httpStatus: 403,
  },
  GENESYS_NOTIFICATION_PERMISSION_DENIED: {
    code: 'GENESYS_NOTIFICATION_PERMISSION_DENIED',
    severity: 'error',
    retryable: false,
    message: 'Genesys denied access to real-time notifications.',
    nextAction:
      'Grant the signed-in user Notifications subscription and topic-specific access, ensure the Code Authorization client permits it, then sign in again.',
    httpStatus: 403,
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
    nextAction: 'No retry is needed; the platform confirmed that no history is available.',
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
  DATABASE_SCHEMA_MISSING: {
    code: 'DATABASE_SCHEMA_MISSING',
    severity: 'error',
    retryable: false,
    message: 'The database is reachable but the observability tables do not exist yet.',
    nextAction: 'Apply the schema once with `npm run db:init` against this database.',
    httpStatus: 503,
  },
  DATABASE_UNREACHABLE: {
    code: 'DATABASE_UNREACHABLE',
    severity: 'error',
    retryable: true,
    message: 'The database could not be reached.',
    nextAction: 'Check that POSTGRES_URL points at a running database and allows this region.',
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
    nextAction: 'Check the capture log and retry.',
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
