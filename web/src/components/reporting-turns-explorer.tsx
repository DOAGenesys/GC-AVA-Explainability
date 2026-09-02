'use client';

import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import {
  ASK_ACTION_RESULTS,
  DIVISION_REPORTING_TURNS_ENDPOINT,
  REPORTING_TURNS_PAGE_SIZE,
  type AskActionResult,
  type ReportingTurnEntity,
  type ReportingTurnsQuery,
  type ReportingTurnsResponse,
} from '@/lib/reporting-turns';
import { CSRF_COOKIE, CSRF_HEADER } from '@/server/auth/cookies';

interface FlowOption {
  flowId: string;
  name: string;
  flowType: string | null;
}

interface SessionGroup {
  sessionId: string;
  conversationId: string | null;
  turns: ReportingTurnEntity[];
  startedAt: string | null;
  completedAt: string | null;
  endType: string | null;
  endReason: string | null;
}

type WindowPreset = '24h' | '3d' | '10d';

const PRESET_MS: Record<WindowPreset, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '10d': 10 * 24 * 60 * 60 * 1000,
};

function csrfToken(): string | null {
  const prefix = `${CSRF_COOKIE}=`;
  const value = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return value ? decodeURIComponent(value.slice(prefix.length)) : null;
}

function intervalFor(preset: WindowPreset): string {
  const end = new Date();
  const start = new Date(end.getTime() - PRESET_MS[preset]);
  return `${start.toISOString()}/${end.toISOString()}`;
}

function responseError(
  body: { error?: { message?: string; nextAction?: string } } | null,
  status: number,
): string {
  const message = body?.error?.message ?? `Genesys returned HTTP ${status}.`;
  return body?.error?.nextAction ? `${message} ${body.error.nextAction}` : message;
}

function displayTime(value: string | null | undefined): string {
  if (!value) return 'Time unavailable';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function shortId(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-5)}`;
}

function confidence(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const normalized = value > 1 ? value : value * 100;
  return `${normalized.toFixed(normalized >= 10 ? 0 : 1)}%`;
}

function groupSessions(entities: ReportingTurnEntity[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  entities.forEach((turn, index) => {
    const sessionId = turn.sessionId || `unidentified-${index}`;
    const existing = groups.get(sessionId);
    if (existing) {
      existing.turns.push(turn);
      existing.completedAt = turn.dateCompleted ?? existing.completedAt;
      existing.endType = turn.sessionEndDetails?.type ?? existing.endType;
      existing.endReason = turn.sessionEndDetails?.reason ?? existing.endReason;
      return;
    }
    groups.set(sessionId, {
      sessionId,
      conversationId: turn.conversation?.id ?? null,
      turns: [turn],
      startedAt: turn.dateCreated ?? null,
      completedAt: turn.dateCompleted ?? null,
      endType: turn.sessionEndDetails?.type ?? null,
      endReason: turn.sessionEndDetails?.reason ?? null,
    });
  });
  return [...groups.values()];
}

export function ReportingTurnsExplorer({ flowOptions }: { flowOptions: FlowOption[] }) {
  const [botFlowId, setBotFlowId] = useState('');
  const [preset, setPreset] = useState<WindowPreset>('24h');
  const [actionId, setActionId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [language, setLanguage] = useState('');
  const [askResults, setAskResults] = useState<AskActionResult[]>([]);
  const [entities, setEntities] = useState<ReportingTurnEntity[]>([]);
  const [pages, setPages] = useState(0);
  const [apiCalls, setApiCalls] = useState(0);
  const [nextUri, setNextUri] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeQueryRef = useRef<ReportingTurnsQuery | null>(null);

  const sessions = useMemo(() => groupSessions(entities), [entities]);
  const totals = useMemo(() => {
    let intents = 0;
    let knowledgeSearches = 0;
    let guardrails = 0;
    for (const turn of entities) {
      if (turn.intent?.name) intents += 1;
      knowledgeSearches +=
        (turn.knowledge?.search ? 1 : 0) + (turn.knowledgeBaseEvents?.search?.length ?? 0);
      if (turn.askActionResult?.toLowerCase() === 'guardrailsviolation') guardrails += 1;
    }
    return { intents, knowledgeSearches, guardrails };
  }, [entities]);
  const selectedFlow = flowOptions.find(
    (flow) => flow.flowId.toLowerCase() === botFlowId.trim().toLowerCase(),
  );
  const incompatibleDisabled = Boolean(sessionId.trim());

  function toggleAskResult(result: AskActionResult) {
    setAskResults((current) =>
      current.includes(result)
        ? current.filter((candidate) => candidate !== result)
        : [...current, result],
    );
  }

  async function fetchSegment(continuationUri?: string) {
    const token = csrfToken();
    if (!token) {
      setError('The security token is missing. Reload the page and try again.');
      return;
    }

    const query: ReportingTurnsQuery = continuationUri
      ? { ...(activeQueryRef.current as ReportingTurnsQuery), continuationUri }
      : {
          botFlowId: botFlowId.trim(),
          interval: intervalFor(preset),
          ...(actionId.trim() ? { actionId: actionId.trim() } : {}),
          ...(sessionId.trim() ? { sessionId: sessionId.trim() } : {}),
          ...(language.trim() ? { language: language.trim() } : {}),
          ...(askResults.length > 0 ? { askActionResults: askResults } : {}),
        };

    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/reporting-turns', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [CSRF_HEADER]: token,
        },
        body: JSON.stringify(query),
      });
      const body = (await response.json().catch(() => null)) as
        ReportingTurnsResponse | { error?: { message?: string; nextAction?: string } } | null;
      if (!response.ok) {
        throw new Error(
          responseError(
            body as { error?: { message?: string; nextAction?: string } },
            response.status,
          ),
        );
      }

      const result = body as ReportingTurnsResponse;
      activeQueryRef.current = query;
      setEntities((current) =>
        continuationUri ? [...current, ...result.entities] : result.entities,
      );
      setPages((current) => (continuationUri ? current + result.pages : result.pages));
      setApiCalls((current) => (continuationUri ? current + result.apiCalls : result.apiCalls));
      setNextUri(result.nextUri);
      setComplete(result.complete);
      setFetchedAt(result.fetchedAt);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Reporting Turns could not be retrieved.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="reporting-workspace">
      <section className="reporting-technical" aria-labelledby="reporting-technical-heading">
        <div>
          <span className="section-kicker">Division-aware bulk analytics</span>
          <h2 id="reporting-technical-heading">What this view retrieves</h2>
          <p>
            Reporting Turns returns conversational evidence across many sessions for one bot flow:
            user input, bot prompts, ask-action outcomes, intents and slots, knowledge searches and
            feedback, guardrail outcomes, and session-end details.
          </p>
        </div>
        <dl>
          <div>
            <dt>Endpoint</dt>
            <dd>
              <code>{DIVISION_REPORTING_TURNS_ENDPOINT}</code>
            </dd>
          </div>
          <div>
            <dt>Pagination</dt>
            <dd>
              {REPORTING_TURNS_PAGE_SIZE} turns per API page. Each continuation load forwards
              Genesys&apos; already-encoded <code>nextUri</code> unchanged; the result is complete
              when none remains.
            </dd>
          </div>
          <div>
            <dt>Retention</dt>
            <dd>Approximately—but never less than—10 days. Older resources are deleted.</dd>
          </div>
          <div>
            <dt>Scope</dt>
            <dd>
              Results are filtered to the signed-in user&apos;s permitted divisions. No
              conversation-by-conversation discovery is performed.
            </dd>
          </div>
        </dl>
      </section>

      <section className="reporting-query" aria-labelledby="reporting-query-heading">
        <div className="builder-heading">
          <div>
            <span className="section-kicker">Query builder</span>
            <h2 id="reporting-query-heading">Explore a bot flow</h2>
            <p>Start broad, then narrow by session, action, language, or ask-action outcome.</p>
          </div>
          <span className="reporting-cost-note">Up to 1,000 turns per load</span>
        </div>

        <div className="reporting-primary-fields">
          <label className="live-field">
            <span>Bot flow ID</span>
            <input
              value={botFlowId}
              onChange={(event) => setBotFlowId(event.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              spellCheck={false}
            />
          </label>
          {flowOptions.length > 0 ? (
            <label className="live-field">
              <span>Known flow</span>
              <select value="" onChange={(event) => setBotFlowId(event.target.value)}>
                <option value="">Choose a known flow…</option>
                {flowOptions.map((flow) => (
                  <option key={flow.flowId} value={flow.flowId}>
                    {flow.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <fieldset className="reporting-window">
            <legend>Completed within</legend>
            {(['24h', '3d', '10d'] as WindowPreset[]).map((value) => (
              <button
                type="button"
                key={value}
                className={preset === value ? 'is-selected' : ''}
                onClick={() => setPreset(value)}
              >
                {value === '3d' ? '3 days' : value === '10d' ? '10 days' : '24 hours'}
              </button>
            ))}
          </fieldset>
        </div>

        <details className="reporting-filters">
          <summary>
            <span>Advanced filters</span>
            <span>
              {[actionId, sessionId, language].filter(Boolean).length + askResults.length} active
            </span>
          </summary>
          <div className="reporting-filter-grid">
            <label className="live-field">
              <span>Session ID</span>
              <input
                value={sessionId}
                onChange={(event) => {
                  setSessionId(event.target.value);
                  if (event.target.value) {
                    setActionId('');
                    setLanguage('');
                    setAskResults([]);
                  }
                }}
                placeholder="Exact session UUID"
                spellCheck={false}
              />
              <small>Cannot be combined with the other advanced filters.</small>
            </label>
            <label className="live-field">
              <span>Action ID</span>
              <input
                value={actionId}
                disabled={incompatibleDisabled}
                onChange={(event) => setActionId(event.target.value)}
                placeholder="Optional action UUID"
                spellCheck={false}
              />
            </label>
            <label className="live-field">
              <span>Language</span>
              <input
                value={language}
                disabled={incompatibleDisabled}
                onChange={(event) => setLanguage(event.target.value)}
                placeholder="For example en-US"
                spellCheck={false}
              />
            </label>
          </div>
          <div className="ask-result-filter">
            <span>Ask-action results</span>
            <div>
              {ASK_ACTION_RESULTS.map((result) => (
                <label key={result}>
                  <input
                    type="checkbox"
                    disabled={incompatibleDisabled}
                    checked={askResults.includes(result)}
                    onChange={() => toggleAskResult(result)}
                  />
                  <span>{result}</span>
                </label>
              ))}
            </div>
          </div>
        </details>

        {error ? (
          <div className="live-error" role="alert">
            <strong>Reporting Turns request failed</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <div className="reporting-query-actions">
          <button
            className="btn-live-primary"
            type="button"
            disabled={loading || !botFlowId.trim()}
            onClick={() => void fetchSegment()}
          >
            {loading && entities.length === 0 ? 'Retrieving turns…' : 'Run reporting query'}
          </button>
          {selectedFlow ? (
            <span>
              Querying <strong>{selectedFlow.name}</strong>
            </span>
          ) : (
            <span>Uses your signed-in user&apos;s division access.</span>
          )}
        </div>
      </section>

      <section className="reporting-results" aria-labelledby="reporting-results-heading">
        <header>
          <div>
            <span className="section-kicker">Explainability evidence</span>
            <h2 id="reporting-results-heading">Reporting turns</h2>
            <p>
              {fetchedAt
                ? `Last response ${displayTime(fetchedAt)}`
                : 'Run a query to inspect recent bot-flow sessions.'}
            </p>
          </div>
          {entities.length > 0 ? (
            <div className="reporting-completeness">
              <span className={complete ? 'is-complete' : ''} />
              {complete ? 'All pages loaded' : 'More pages available'}
            </div>
          ) : null}
        </header>

        <div className="reporting-kpis">
          <div>
            <span>Sessions</span>
            <strong>{sessions.length.toLocaleString()}</strong>
          </div>
          <div>
            <span>Turns</span>
            <strong>{entities.length.toLocaleString()}</strong>
          </div>
          <div>
            <span>Intent detections</span>
            <strong>{totals.intents.toLocaleString()}</strong>
          </div>
          <div>
            <span>Knowledge searches</span>
            <strong>{totals.knowledgeSearches.toLocaleString()}</strong>
          </div>
          <div>
            <span>Guardrail outcomes</span>
            <strong>{totals.guardrails.toLocaleString()}</strong>
          </div>
          <div>
            <span>API pages</span>
            <strong>{pages.toLocaleString()}</strong>
            <small>{apiCalls.toLocaleString()} calls including retries</small>
          </div>
        </div>

        {sessions.length === 0 ? (
          <div className="reporting-empty">
            <span aria-hidden="true">↳</span>
            <strong>{fetchedAt ? 'No turns matched this query' : 'Ready for a bot flow'}</strong>
            <p>
              {fetchedAt
                ? 'Widen the interval or remove advanced filters. Reporting Turns are retained for approximately 10 days.'
                : 'The result will be grouped by session in Genesys reverse-chronological order.'}
            </p>
          </div>
        ) : (
          <div className="reporting-session-list">
            {sessions.map((session, index) => (
              <ReportingSession
                key={session.sessionId}
                session={session}
                initiallyOpen={index === 0}
              />
            ))}
          </div>
        )}

        {nextUri ? (
          <div className="reporting-load-more">
            <p>
              Genesys returned a <code>nextUri</code>. Continue to complete the result set without
              re-encoding its cursor.
            </p>
            <button type="button" disabled={loading} onClick={() => void fetchSegment(nextUri)}>
              {loading ? 'Loading next segment…' : 'Load next 1,000 turns'}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ReportingSession({
  session,
  initiallyOpen,
}: {
  session: SessionGroup;
  initiallyOpen: boolean;
}) {
  return (
    <details className="reporting-session" open={initiallyOpen}>
      <summary>
        <span className="reporting-session-count">{session.turns.length}</span>
        <span>
          <strong>Session {shortId(session.sessionId)}</strong>
          <small>
            {displayTime(session.startedAt)}
            {session.conversationId ? ` · Conversation ${shortId(session.conversationId)}` : ''}
          </small>
        </span>
        <span className="reporting-session-outcome">
          {session.endType ?? 'Session'}
          <small>{session.endReason ?? 'Outcome unavailable'}</small>
        </span>
        <span className="reporting-disclosure" aria-hidden="true">
          +
        </span>
      </summary>
      <div className="reporting-session-body">
        <div className="reporting-session-links">
          <code>{session.sessionId}</code>
          {!session.sessionId.startsWith('unidentified-') ? (
            <Link href="/sessions">Open the execution archive →</Link>
          ) : null}
        </div>
        {session.turns.map((turn, index) => (
          <ReportingTurn
            key={`${session.sessionId}-${turn.dateCreated ?? index}`}
            turn={turn}
            index={index}
          />
        ))}
      </div>
    </details>
  );
}

function ReportingTurn({ turn, index }: { turn: ReportingTurnEntity; index: number }) {
  const searches = [
    ...(turn.knowledge?.search ? [turn.knowledge.search] : []),
    ...(turn.knowledgeBaseEvents?.search ?? []),
  ];
  const documents = searches.flatMap((search) => search.documents ?? []);

  return (
    <article className="reporting-turn">
      <div className="reporting-turn-rail">
        <span>{index + 1}</span>
        <i />
      </div>
      <div className="reporting-turn-content">
        <header>
          <span>{displayTime(turn.dateCreated)}</span>
          {turn.askActionResult ? (
            <span
              className={
                turn.askActionResult === 'GuardrailsViolation'
                  ? 'turn-result is-alert'
                  : 'turn-result'
              }
            >
              {turn.askActionResult}
            </span>
          ) : null}
        </header>

        {turn.userInput ? (
          <div className="reporting-message is-user">
            <span>User</span>
            <p>{turn.userInput}</p>
          </div>
        ) : null}
        {(turn.botPrompts ?? []).map((prompt, promptIndex) => (
          <div className="reporting-message is-bot" key={`${promptIndex}-${prompt}`}>
            <span>Bot</span>
            <p>{prompt}</p>
          </div>
        ))}

        <div className="reporting-evidence-grid">
          {turn.askAction ? (
            <section>
              <span>Ask action</span>
              <strong>
                {turn.askAction.actionName ?? turn.askAction.actionType ?? 'Unnamed action'}
              </strong>
              <small>
                {turn.askAction.actionType ?? 'Type unavailable'}
                {turn.askAction.actionNumber != null ? ` · #${turn.askAction.actionNumber}` : ''}
              </small>
            </section>
          ) : null}

          {turn.intent?.name ? (
            <section>
              <span>Detected intent</span>
              <strong>{turn.intent.name}</strong>
              <small>{confidence(turn.intent.confidence)} confidence</small>
              {(turn.intent.slots?.length ?? 0) > 0 ? (
                <div className="reporting-slots">
                  {turn.intent?.slots?.map((slot, slotIndex) => (
                    <span key={`${slot.name ?? 'slot'}-${slotIndex}`}>
                      {slot.name ?? 'slot'} = <b>{slot.value ?? '—'}</b>
                    </span>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {searches.length > 0 ? (
            <section className="is-knowledge">
              <span>Knowledge evidence</span>
              <strong>
                {searches[0]?.searchQuery ?? searches[0]?.query ?? 'Knowledge search'}
              </strong>
              <small>
                {documents.length} candidate {documents.length === 1 ? 'document' : 'documents'}
                {turn.knowledge?.feedback?.rating != null
                  ? ` · rating ${turn.knowledge.feedback.rating}`
                  : ''}
              </small>
              {documents.length > 0 ? (
                <div className="knowledge-documents">
                  {documents.slice(0, 5).map((document, documentIndex) => (
                    <details key={`${document.id ?? 'document'}-${documentIndex}`}>
                      <summary>
                        <span>{document.question ?? document.id ?? 'Knowledge document'}</span>
                        <span>{confidence(document.confidence)}</span>
                      </summary>
                      <p>{document.answer ?? 'No answer text returned.'}</p>
                    </details>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>

        <details className="reporting-raw">
          <summary>Complete ReportingTurn JSON</summary>
          <pre>{JSON.stringify(turn, null, 2)}</pre>
        </details>
      </div>
    </article>
  );
}
