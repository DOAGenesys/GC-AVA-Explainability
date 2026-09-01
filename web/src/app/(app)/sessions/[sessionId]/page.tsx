import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { SessionTimelineView } from '@/components/session-timeline';
import { TraceSummary, TraceTimeline } from '@/components/trace';
import { Card, Pill, formatDateTime, outcomeTone } from '@/components/ui';
import { buildSessionTimeline } from '@/lib/session-timeline';
import { getExecution, getSessionDetail, listTurnsForSession } from '@/server/db';

export const dynamic = 'force-dynamic';

/**
 * One session, explained from every available source.
 *
 * Historical rows can combine reporting analytics with execution history. Event-driven captures
 * are projected directly from Jobs history, whose nested AVA turns provide their conversation.
 */
export default async function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const session = await getSessionDetail(sessionId);
  if (!session) notFound();

  const [turns, execution] = await Promise.all([
    listTurnsForSession(sessionId),
    session.executionId ? getExecution(session.executionId) : Promise.resolve(null),
  ]);

  const trace = execution?.parsedTrace ?? null;
  const timeline = buildSessionTimeline(turns, trace);

  return (
    <>
      <PageHeader
        eyebrow="Session explainability"
        title={session.flowName ?? 'AVA session'}
        backHref="/sessions"
        backLabel="All sessions"
        description={
          <div className="identifier-row">
            <span className="mono-id">{session.sessionId}</span>
            {session.conversationId ? (
              <>
                <span className="identifier-divider" aria-hidden="true" />
                <span>Conversation</span>
                <span className="mono-id">{session.conversationId}</span>
              </>
            ) : null}
          </div>
        }
      />

      <div className="stack">
        <section className="session-overview" aria-label="Session summary">
          <div className="session-outcome">
            <span className="kpi-label">Outcome</span>
            <div>
              <Pill tone={outcomeTone(session.botResultCategory)}>
                {session.botResult ?? 'Unknown'}
              </Pill>
            </div>
            <span className="kpi-note">{session.botResultCategory ?? 'Unclassified'}</span>
          </div>
          <div className="session-fact">
            <span>Started</span>
            <strong>{formatDateTime(session.dateCreated)}</strong>
            <small>Completed {formatDateTime(session.dateCompleted)}</small>
          </div>
          <div className="session-fact">
            <span>Channel</span>
            <strong>{session.channelName ?? 'Unknown'}</strong>
            <small>{session.language ?? 'Language unavailable'}</small>
          </div>
          <div className="session-fact">
            <span>Conversation</span>
            <strong>
              {timeline.source === 'trace' ? timeline.avaTraceTurns : turns.length}{' '}
              {timeline.source === 'trace' ? 'captured turns' : 'reporting turns'}
            </strong>
            <small>{trace ? `${trace.toolCalls.length} tool calls` : 'Transcript fidelity'}</small>
          </div>
        </section>

        {session.botResultCategory === 'Execution capture' ? (
          <div className="callout">
            <strong>Session created from Jobs execution history</strong>
            The flow exit, AVA conversation and tool evidence below come from the archived trace.
            Bot-session analytics fields such as channel and analytics outcome category are not part
            of a Jobs response and are therefore left unknown rather than inferred.
          </div>
        ) : null}

        <Card
          title="Conversation"
          subtitle="Messages and the tools they triggered, in one evidence-aligned timeline"
          action={
            <Pill tone={trace ? (trace.truncated ? 'warn' : 'good') : 'neutral'}>
              {trace ? (trace.truncated ? 'Partial trace' : 'Full trace') : 'Transcript only'}
            </Pill>
          }
        >
          <SessionTimelineView timeline={timeline} />

          {!trace && execution?.retrievalStatus === 'NO_HISTORY' ? (
            <div className="timeline-footnote">
              <strong>Why tool detail is unavailable:</strong> this execution did not reach its
              flow&apos;s exit, so Genesys permanently returns no execution history
              {execution.jobsStatusCode ? ` (status ${execution.jobsStatusCode})` : ''}.
            </div>
          ) : null}

          {trace ? (
            <details className="flow-trace-disclosure">
              <summary>
                <span>
                  <strong>Flow execution details</strong>
                  <small>Inspect states, waits, transitions, and raw action evidence</small>
                </span>
                <span className="summary-action">
                  {trace.items.length} events
                  <span className="disclosure-icon" aria-hidden="true">
                    +
                  </span>
                </span>
              </summary>
              <div className="flow-trace-body">
                <TraceSummary trace={trace} />
                {trace.truncated ? (
                  <div className="timeline-notice is-warning">
                    <strong>This trace is truncated.</strong>
                    Treat any missing item as unknown rather than evidence that it did not happen.
                  </div>
                ) : null}
                <div className="trace-section-head">
                  <span className="page-eyebrow">Ordered flow timeline</span>
                  <p>Tool calls remain expanded with their recorded inputs and outputs.</p>
                </div>
                <TraceTimeline trace={trace} />
              </div>
            </details>
          ) : null}
        </Card>
      </div>
    </>
  );
}
