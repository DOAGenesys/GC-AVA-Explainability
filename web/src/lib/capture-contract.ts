/** Shared response contract between the Jobs capture backend and Live capture UI. */

export type CaptureExecutionStatus =
  'skipped_settled' | 'skipped_duplicate' | 'archived' | 'no_history' | 'download_failed';

export interface CaptureExecutionResult {
  executionId: string;
  status: CaptureExecutionStatus;
  jobsStatusCode: string | null;
  bytes?: number;
  /** Route-safe id of the Sessions entry materialized from this Jobs result. */
  sessionId?: string;
}

export interface CaptureJobSummary {
  size: number;
  accepted: boolean;
  jobId?: string;
  jobState?: string;
  entities?: number;
  apiCalls: number;
  error?: string;
}

export interface CaptureMetrics {
  requested: number;
  deduped: number;
  skippedSettled: number;
  fetched: number;
  archived: number;
  noHistory: number;
  downloadFailed: number;
  apiCallsPerExecution: number | null;
  jobs: CaptureJobSummary[];
  jobApiCalls: number;
}

export interface CaptureResponse {
  ok: boolean;
  apiCalls: number;
  results: CaptureExecutionResult[];
  metrics: CaptureMetrics;
}
