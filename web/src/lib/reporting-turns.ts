export const DIVISION_REPORTING_TURNS_ENDPOINT =
  '/api/v2/analytics/botflows/{botFlowId}/divisions/reportingturns';
export const REPORTING_TURNS_PAGE_SIZE = 250;
/** Bound one browser response to 1,000 turns; subsequent segments resume from opaque nextUri. */
export const REPORTING_TURNS_MAX_PAGES = 4;

export const ASK_ACTION_RESULTS = [
  'AgentRequestedByUser',
  'ConfirmationRequired',
  'DisambiguationRequired',
  'Error',
  'ExpressionError',
  'NoInputCollection',
  'NoInputConfirmation',
  'NoInputDisambiguation',
  'NoMatchCollection',
  'NoMatchConfirmation',
  'NoMatchDisambiguation',
  'SuccessCollection',
  'SkippedCollection',
  'SuccessConfirmationNo',
  'SuccessConfirmationYes',
  'SuccessDisambiguation',
  'SuccessDisambiguationNone',
  'GuardrailsViolation',
] as const;

export type AskActionResult = (typeof ASK_ACTION_RESULTS)[number];

export interface ReportingTurnsQuery {
  botFlowId: string;
  interval: string;
  actionId?: string;
  sessionId?: string;
  language?: string;
  askActionResults?: AskActionResult[];
  continuationUri?: string;
}

export interface ReportingIntentSlot {
  name?: string;
  value?: string;
  type?: string;
  confidence?: number;
}

export interface ReportingKnowledgeDocument {
  id?: string;
  question?: string;
  answer?: string;
  confidence?: number;
}

export interface ReportingKnowledgeSearch {
  searchId?: string;
  knowledgeBaseId?: string;
  documents?: ReportingKnowledgeDocument[];
  searchQuery?: string;
  answerDocumentId?: string;
  query?: string;
}

export interface ReportingTurnEntity {
  userInput?: string;
  botPrompts?: string[];
  sessionId?: string;
  conversation?: { id?: string; selfUri?: string };
  askAction?: {
    actionId?: string;
    actionName?: string;
    actionNumber?: number;
    actionType?: string;
  };
  intent?: {
    name?: string;
    id?: string;
    confidence?: number;
    slots?: ReportingIntentSlot[];
  };
  knowledge?: {
    knowledgeBaseId?: string;
    feedback?: {
      searchId?: string;
      rating?: number;
      documents?: ReportingKnowledgeDocument[];
    };
    search?: ReportingKnowledgeSearch;
  };
  knowledgeBaseEvents?: {
    search?: ReportingKnowledgeSearch[];
    feedback?: {
      searchId?: string;
      knowledgeBaseId?: string;
      documents?: ReportingKnowledgeDocument[];
      feedbackRating?: number;
      documentVariationId?: string;
      documentVersionId?: string;
    }[];
  };
  dateCreated?: string;
  dateCompleted?: string;
  askActionResult?: string;
  sessionEndDetails?: { type?: string; reason?: string };
}

export interface ReportingTurnsResponse {
  entities: ReportingTurnEntity[];
  pages: number;
  apiCalls: number;
  sessions: number;
  complete: boolean;
  nextUri: string | null;
  fetchedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INTERVAL_MS = 10 * 24 * 60 * 60 * 1000 + 60_000;
const ASK_RESULTS = new Set<string>(ASK_ACTION_RESULTS);

export function validateReportingTurnsQuery(
  value: unknown,
): { ok: true; query: ReportingTurnsQuery } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const input = value as Record<string, unknown>;
  const botFlowId = typeof input.botFlowId === 'string' ? input.botFlowId.trim().toLowerCase() : '';
  if (!UUID.test(botFlowId)) return { ok: false, error: 'botFlowId must be a UUID' };

  const interval = typeof input.interval === 'string' ? input.interval.trim() : '';
  const [startRaw, endRaw, extra] = interval.split('/');
  const start = Date.parse(startRaw ?? '');
  const end = Date.parse(endRaw ?? '');
  if (extra !== undefined || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    return { ok: false, error: 'interval must be a valid ascending ISO-8601 start/end range' };
  }
  if (end - start > MAX_INTERVAL_MS) {
    return { ok: false, error: 'interval cannot exceed the approximately 10-day retention window' };
  }

  const optionalUuid = (
    field: 'actionId' | 'sessionId',
  ): string | undefined | { error: string } => {
    const raw = input[field];
    if (raw == null || raw === '') return undefined;
    if (typeof raw !== 'string' || !UUID.test(raw.trim())) {
      return { error: `${field} must be a UUID` };
    }
    return raw.trim().toLowerCase();
  };
  const actionId = optionalUuid('actionId');
  if (typeof actionId === 'object') return { ok: false, error: actionId.error };
  const sessionId = optionalUuid('sessionId');
  if (typeof sessionId === 'object') return { ok: false, error: sessionId.error };

  const language =
    typeof input.language === 'string' && input.language.trim() ? input.language.trim() : undefined;
  if (language && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) {
    return { ok: false, error: 'language must be a valid language tag such as en-US' };
  }

  const rawResults = input.askActionResults;
  if (rawResults != null && !Array.isArray(rawResults)) {
    return { ok: false, error: 'askActionResults must be an array' };
  }
  const askActionResults = [
    ...new Set(
      (rawResults ?? []).filter(
        (result): result is AskActionResult =>
          typeof result === 'string' && ASK_RESULTS.has(result),
      ),
    ),
  ];
  if (Array.isArray(rawResults) && askActionResults.length !== rawResults.length) {
    return { ok: false, error: 'askActionResults contains an unsupported result' };
  }
  if (sessionId && (actionId || language || askActionResults.length > 0)) {
    return {
      ok: false,
      error: 'sessionId cannot be combined with actionId, language, or askActionResults',
    };
  }

  const continuationUri =
    typeof input.continuationUri === 'string' && input.continuationUri
      ? reportingTurnsNextPath(input.continuationUri, botFlowId)
      : undefined;
  if (input.continuationUri && !continuationUri) {
    return { ok: false, error: 'continuationUri does not belong to this reporting-turns query' };
  }

  return {
    ok: true,
    query: {
      botFlowId,
      interval: `${new Date(start).toISOString()}/${new Date(end).toISOString()}`,
      ...(actionId ? { actionId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(language ? { language } : {}),
      ...(askActionResults.length > 0 ? { askActionResults } : {}),
      ...(continuationUri ? { continuationUri } : {}),
    },
  };
}

/**
 * Validate and preserve Genesys' already-encoded continuation URI.
 *
 * Parsing with URL inspects the pathname without decoding/re-encoding the query string; returning
 * pathname + search lets the HTTP client forward the opaque cursor exactly once.
 */
export function reportingTurnsNextPath(nextUri: string, botFlowId: string): string | null {
  try {
    const parsed = new URL(nextUri, 'https://api.invalid');
    const expected = `/api/v2/analytics/botflows/${botFlowId}/divisions/reportingturns`;
    if (parsed.pathname.toLowerCase() !== expected.toLowerCase()) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}
