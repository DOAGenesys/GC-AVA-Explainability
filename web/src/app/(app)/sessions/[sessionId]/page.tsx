import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { SessionTimelineView } from '@/components/session-timeline';
import { TechnicalAssets } from '@/components/technical-assets';
import { TraceSummary, TraceTimeline } from '@/components/trace';
import { TurnEvidenceView } from '@/components/turn-evidence';
import { Card, Pill, formatDateTime, outcomeTone } from '@/components/ui';
import { buildSessionTimeline } from '@/lib/session-timeline';
import { describeSessionEnd, type TurnSession } from '@/lib/turn-evidence';
import { getExecution, getSessionDetail } from '@/server/db';
import { findTurnSessionByConversation, getTurnSession } from '@/server/turns/store';

export const dynamic = 'force-dynamic';

const TURNS_ASSET = {
  name: 'Bot flow reporting turns',
  role: 'Persisted hourly by the server-side sweep: every AVA turn with customer input, AVA prompts, the AVA name and version, and each tool call with status and latency. Recorded whether or not the flow reached its exit; tool inputs and outputs are not included.',
  reference: 'GET /api/v2/analytics/botflows/{botFlowId}/divisions/reportingturns',
};

async function loadTurnSession(
  sessionId: string,
  conversationId: string | null,
): Promise<TurnSession | null> {
  const direct = await getTurnSession(sessionId);
  if (direct.state !== 'ready') return null;
  if (direct.data) return direct.data;
  if (!conversationId) return null;
  const byConversation = await findTurnSessionByConversation(conversationId);
  return byConversation.state === 'ready' ? byConversation.data : null;
}

function IdentifierRow({
  sessionId,
  conversationId,
}: {
  sessionId: string;
  conversationId: string | null;
}) {
  return (
    <div className="identifier-row">
      <span className="mono-id">{sessionId}</span>
      {conversationId ? (
        <>
          <span className="identifier-divider" aria-hidden="true" />
          <span>Conversation</span>
          <span className="mono-id">{conversationId}</span>
        </>
      ) : null}
    </div>
  );
}

/** A session known only from the turn sweep: no stored analytics row and no captured execution. */
function TurnOnlySession({ session }: { session: TurnSession }) {
  const end = describeSessionEnd(session);
  return (
    <>
      <PageHeader
        eyebrow="Session explainability"
        title={session.flowName ?? 'AVA session'}
        backHref="/sessions"
        backLabel="All sessions"
        description={
          <IdentifierRow sessionId={session.sessionId} conversationId={session.conversationId} />
        }
      />

      <div className="stack">
        <TechnicalAssets
          summary="This session was recorded by the bot flow's reporting turns and persisted by the hourly server-side sweep. No execution history was captured for it."
          assets={[
            TURNS_ASSET,
            {
              name: 'AVA identity',
              role: 'The agent that handled each turn, with its published version, as Genesys recorded it at the time of the turn.',
              reference: 'askAction.agentDetails',
            },
            {
              name: 'Tool-call metadata',
              role: 'Name, type, status, latency, origin, and target for each tool the AVA called during a turn.',
              reference: 'reportingturns · toolCalls[]',
            },
          ]}
        />

        <section className="session-overview" aria-label="Session summary">
          <div className="session-outcome">
            <span className="kpi-label">Outcome</span>
            <div>
              <Pill tone={end ? outcomeTone(session.endType) : 'warn'}>
                {end ?? 'No exit reported'}
              </Pill>
            </div>
            <span className="kpi-note">Reporting turns</span>
          </div>
          <div className="session-fact">
            <span>Started</span>
            <strong>{formatDateTime(session.firstTurnAt)}</strong>
            <small>Last turn {formatDateTime(session.lastTurnAt)}</small>
          </div>
          <div className="session-fact">
            <span>AVA</span>
            <strong>{session.agentName ?? 'Unknown'}</strong>
            <small>
              {session.agentVersion ? `Version ${session.agentVersion}` : 'Version unavailable'}
            </small>
          </div>
          <div className="session-fact">
            <span>Conversation</span>
            <strong>{session.turnCount} reported turns</strong>
            <small>
              {session.toolCallCount} tool calls
              {session.toolFailureCount > 0 ? ` · ${session.toolFailureCount} failed` : ''}
            </small>
          </div>
        </section>

        <div className="callout">
          <strong>Turn metadata, not a full trace</strong>
          Reporting turns prove which tools the AVA called, in which turn, and how each call ended.
          The inputs the AVA chose and the outputs it received are only in execution history, which
          Genesys does not keep for a session that never reaches its flow&apos;s exit.
        </div>

        <Card
          title="Conversation"
          subtitle="Customer input, tool calls, and AVA prompts, in turn order"
          action={<Pill tone="info">Turn metadata</Pill>}
        >
          <TurnEvidenceView session={session} />
        </Card>
      </div>
    </>
  );
}

/**
 * One session, explained from every available source.
 *
 * Event-driven captures are projected directly from Jobs history, whose nested AVA turns provide
 * their conversation. Reporting turns from the server-side sweep fill in when there is no history
 * and add the AVA's identity and per-turn tool outcomes when there is.
 */
export default async function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const session = await getSessionDetail(sessionId);
  if (!session) {
    const turnOnly = await getTurnSession(sessionId);
    if (turnOnly.state === 'ready' && turnOnly.data) {
      return <TurnOnlySession session={turnOnly.data} />;
    }
    notFound();
  }

  const [execution, turnSession] = await Promise.all([
    session.executionId ? getExecution(session.executionId) : Promise.resolve(null),
    loadTurnSession(sessionId, session.conversationId),
  ]);

  const trace = execution?.parsedTrace ?? null;
  const timeline = buildSessionTimeline(trace);
  const turnConversation = trace ? null : turnSession;

  return (
    <>
      <PageHeader
        eyebrow="Session explainability"
        title={session.flowName ?? 'AVA session'}
        backHref="/sessions"
        backLabel="All sessions"
        description={
          <IdentifierRow sessionId={session.sessionId} conversationId={session.conversationId} />
        }
      />

      <div className="stack">
        <TechnicalAssets
          summary={
            trace
              ? 'The flow notification identified this execution; its completed Jobs result supplied the detailed history shown below.'
              : turnSession
                ? 'Genesys did not return a downloadable Jobs history for this session, so its conversation and tool calls come from the bot flow’s reporting turns.'
                : 'The flow notification identified this execution, but Genesys did not return a downloadable Jobs history for it.'
          }
          assets={[
            {
              name: 'Notification pointer',
              role: 'Binds executionId, flowId, and conversationId at the moment the flow-instance event is emitted.',
              reference: 'v2.flows.instances.flow.{id}',
            },
            {
              name: 'Execution-history job',
              role: trace
                ? 'The execution ID was submitted in a job of up to 10 IDs; its successful result returned a pre-signed downloadUri.'
                : 'The individual job result explains why no downloadable history is available.',
              reference: 'POST /api/v2/flows/instances/jobs · GET …/jobs/{jobId}',
            },
            {
              name: 'Downloaded history',
              role: 'Contains the ordered flow states, waits, transitions, nested AVA messages, data-action inputs and outputs, exit reason, and truncation flag.',
              reference: 'job result entity → downloadUri',
            },
            ...(turnSession ? [TURNS_ASSET] : []),
          ]}
        />

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
            <span>{turnSession?.agentName ? 'AVA' : 'Channel'}</span>
            <strong>{turnSession?.agentName ?? session.channelName ?? 'Unknown'}</strong>
            <small>
              {turnSession?.agentName
                ? turnSession.agentVersion
                  ? `Version ${turnSession.agentVersion}`
                  : 'Version unavailable'
                : (session.language ?? 'Language unavailable')}
            </small>
          </div>
          <div className="session-fact">
            <span>Conversation</span>
            <strong>
              {turnConversation
                ? `${turnConversation.turnCount} reported turns`
                : `${timeline.avaTraceTurns} captured turns`}
            </strong>
            <small>
              {trace
                ? `${trace.toolCalls.length} tool calls`
                : turnSession
                  ? `${turnSession.toolCallCount} tool calls`
                  : 'Transcript fidelity'}
            </small>
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

        {turnConversation ? (
          <Card
            title="Conversation"
            subtitle="Customer input, tool calls, and AVA prompts from reporting turns"
            action={<Pill tone="info">Turn metadata</Pill>}
          >
            <TurnEvidenceView session={turnConversation} />
            {execution?.retrievalStatus === 'NO_HISTORY' ? (
              <div className="timeline-footnote">
                <strong>Why tool inputs and outputs are unavailable:</strong> this execution did not
                reach its flow&apos;s exit, so Genesys permanently returns no execution history
                {execution.jobsStatusCode ? ` (status ${execution.jobsStatusCode})` : ''}. The
                reporting turns above still show every tool call and its outcome.
              </div>
            ) : null}
          </Card>
        ) : (
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

            {trace && turnSession ? (
              <details className="flow-trace-disclosure">
                <summary>
                  <span>
                    <strong>Reporting turns</strong>
                    <small>
                      The same session as Genesys analytics recorded it, with the AVA version and
                      per-turn tool outcomes
                    </small>
                  </span>
                  <span className="summary-action">
                    {turnSession.turnCount} turns
                    <span className="disclosure-icon" aria-hidden="true">
                      +
                    </span>
                  </span>
                </summary>
                <div className="flow-trace-body">
                  <TurnEvidenceView session={turnSession} />
                </div>
              </details>
            ) : null}
          </Card>
        )}
      </div>
    </>
  );
}
