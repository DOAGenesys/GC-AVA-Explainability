import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TraceSummary, TraceTimeline } from '@/components/trace';
import { Card, Empty, Pill, formatDateTime, outcomeTone } from '@/components/ui';
import { getExecution, getSessionDetail, listTurnsForSession, type TurnRow } from '@/server/db';
import { parseTrace, type FlowExecutionTrace } from '@/server/genesys/ava';

export const dynamic = 'force-dynamic';

/**
 * One session, explained from both sources at once.
 *
 * The transcript comes from bot flow analytics and exists for every session. The trace comes from
 * execution history and exists only when the execution reached its flow's exit. Showing them on
 * one page - and saying plainly when the trace is absent and why - is the whole point: the
 * alternative is a viewer that looks broken for the majority of real conversations.
 */
export default async function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const session = await getSessionDetail(sessionId);
  if (!session) notFound();

  const [turns, execution] = await Promise.all([
    listTurnsForSession(sessionId),
    session.executionId ? getExecution(session.executionId) : Promise.resolve(null),
  ]);

  const trace = execution?.trace != null ? parseTrace(execution.trace as FlowExecutionTrace) : null;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>{session.flowName ?? 'AVA session'}</h1>
          <p>
            <span className="mono-id">{session.sessionId}</span>
            {session.conversationId ? (
              <>
                {' · conversation '}
                <span className="mono-id">{session.conversationId}</span>
              </>
            ) : null}
          </p>
        </div>
        <Link href="/sessions">Back to sessions</Link>
      </header>

      <div className="stack">
        <Card>
          <div className="grid grid-kpi">
            <div className="kpi">
              <span className="kpi-label">Outcome</span>
              <span style={{ marginTop: 6 }}>
                <Pill tone={outcomeTone(session.botResultCategory)}>
                  {session.botResult ?? 'Unknown'}
                </Pill>
              </span>
              <span className="kpi-note">{session.botResultCategory ?? '—'}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Started</span>
              <span className="kpi-note" style={{ fontSize: 14, marginTop: 8 }}>
                {formatDateTime(session.dateCreated)}
              </span>
              <span className="kpi-note">Completed {formatDateTime(session.dateCompleted)}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Channel</span>
              <span className="kpi-note" style={{ fontSize: 14, marginTop: 8 }}>
                {session.channelName ?? '—'}
              </span>
              <span className="kpi-note">{session.language ?? '—'}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Turns</span>
              <span className="kpi-value">{turns.length}</span>
            </div>
          </div>
        </Card>

        <Card
          title="Transcript"
          subtitle="From bot flow reporting turns, captured before the platform's 10-day retention expires"
        >
          {turns.length > 0 ? (
            <div className="transcript">
              {turns.map((turn, index) => (
                <TurnBubbles key={turn.turnId} turn={turn} position={index + 1} />
              ))}
            </div>
          ) : (
            <Empty title="No turns captured for this session">
              Turn data is retained upstream for 10 days. If this session is older than that and was
              never ingested, the transcript no longer exists anywhere.
            </Empty>
          )}
        </Card>

        {trace ? (
          <>
            <Card title="Execution trace" subtitle="Full fidelity, retrieved via the Jobs API">
              <TraceSummary trace={trace} />
              {trace.truncated ? (
                <div className="callout alert" style={{ marginTop: 14 }}>
                  <strong>This trace is truncated.</strong>
                  The platform marked the execution history as incomplete, so items are missing from
                  the timeline below. Treat any absence as unknown rather than as evidence that
                  something did not happen.
                </div>
              ) : null}
            </Card>

            <Card
              title="What the AVA did"
              subtitle="Ordered timeline; tool calls expanded with the inputs chosen and the outputs returned"
            >
              <TraceTimeline trace={trace} />
            </Card>
          </>
        ) : (
          <Card title="Execution trace">
            <Empty
              title={
                execution?.retrievalStatus === 'NO_HISTORY'
                  ? 'Genesys holds no execution history for this conversation'
                  : 'No execution trace yet'
              }
            >
              {execution?.retrievalStatus === 'NO_HISTORY' ? (
                <>
                  Execution history only exists for executions that reach their flow&apos;s exit.
                  This one did not, so the Jobs API answers 404 for it permanently
                  {execution.jobsStatusCode ? ` (status ${execution.jobsStatusCode})` : ''}. The
                  transcript above is the complete record of this conversation.
                </>
              ) : (
                <>
                  The fidelity pass runs every ten minutes and retrieves executions in batches of
                  ten. If this session is recent, the trace should appear shortly.
                </>
              )}
            </Empty>
          </Card>
        )}
      </div>
    </>
  );
}

/**
 * Render one reporting turn as the exchange it represents.
 *
 * Both sides are defensive about shape because the platform returns the utterance under different
 * keys depending on channel and input mode, and the turn-level metadata fields are still changing.
 */
function TurnBubbles({ turn, position }: { turn: TurnRow; position: number }) {
  const user = extractText(turn.userInput);
  const bot = extractText(turn.botPrompts);

  // The platform sends no turn number, so the label is the turn's position in the ordered
  // transcript. Showing that is honest and useful; showing "turn ?" was neither.
  const label = turn.sequence ?? position;

  return (
    <>
      {user ? (
        <div className="bubble user">
          <div className="bubble-meta">Customer · turn {label}</div>
          {user}
        </div>
      ) : null}
      {bot ? (
        <div className="bubble bot">
          <div className="bubble-meta">
            AVA
            {turn.askAction ? ` · ${turn.askAction}` : ''}
            {turn.askActionResult ? ` · ${turn.askActionResult}` : ''}
          </div>
          {bot}
        </div>
      ) : null}
    </>
  );
}

function extractText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim() || null;

  if (Array.isArray(value)) {
    const parts = value.map(extractText).filter((v): v is string => Boolean(v));
    return parts.length > 0 ? parts.join('\n') : null;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'utterance', 'value', 'message', 'body']) {
      const candidate = extractText(record[key]);
      if (candidate) return candidate;
    }
    // Nothing recognisable: fall through to the nested collections the API commonly uses.
    for (const key of ['prompts', 'messages', 'inputs', 'segments']) {
      const candidate = extractText(record[key]);
      if (candidate) return candidate;
    }
  }

  return null;
}
