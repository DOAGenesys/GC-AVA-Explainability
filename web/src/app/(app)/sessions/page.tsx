import Link from 'next/link';
import { DataTable } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { SessionsRefreshControl } from '@/components/sessions-refresh-control';
import { TechnicalAssets } from '@/components/technical-assets';
import {
  Card,
  Empty,
  Pill,
  ShortId,
  formatDateTime,
  outcomeTone,
  retrievalTone,
} from '@/components/ui';
import { mergeTurnSessions } from '@/lib/turn-evidence';
import { listSessions } from '@/server/db';
import { listTurnSessions } from '@/server/turns/store';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 7;
const SESSION_LIMIT = 300;

export default async function SessionsPage() {
  const [stored, turnSessions] = await Promise.all([
    listSessions(WINDOW_DAYS, SESSION_LIMIT),
    listTurnSessions(WINDOW_DAYS, SESSION_LIMIT),
  ]);
  const sessions = mergeTurnSessions(
    stored,
    turnSessions.state === 'ready' ? turnSessions.data : [],
    SESSION_LIMIT,
  );
  const turnOnly = sessions.filter((session) => session.source === 'turns').length;

  return (
    <>
      <PageHeader
        eyebrow="Explainability"
        title="Sessions"
        description={
          <>
            AVA sessions observed in the last {WINDOW_DAYS} days. Live captures become available
            here as soon as their Jobs retrieval finishes; sessions recorded by the hourly
            server-side turn sweep appear even when no browser was capturing and Genesys kept no
            execution history.
          </>
        }
        action={
          <div className="sessions-page-actions">
            <SessionsRefreshControl />
            <Link className="btn-link-primary" href="/live">
              Open live capture
            </Link>
          </div>
        }
      />

      <div className="stack">
        <TechnicalAssets
          summary="Jobs-captured sessions start with a flow notification and inherit the retrieval outcome for that execution ID. Turn-metadata sessions come from the bot flow's reporting turns, which record every AVA session whether or not it reached the flow's exit."
          assets={[
            {
              name: 'Flow-instance event',
              role: 'The notification identifies the execution, flow, and conversation that belong together before any history is requested.',
              reference: 'v2.flows.instances.flow.{id}',
            },
            {
              name: 'Bulk Jobs request',
              role: 'The execution ID can share one asynchronous request with up to nine others; polling returns an individual result for each ID.',
              reference: 'POST /api/v2/flows/instances/jobs · GET …/jobs/{jobId}',
            },
            {
              name: 'Per-execution outcome',
              role: 'A downloadUri means full history is available; a confirmed 404 means NO_HISTORY. Jobs does not supply bot-session analytics classifications.',
              reference: 'job result statusCode + downloadUri',
            },
            {
              name: 'Bot flow reporting turns',
              role: 'Each AVA turn with the customer input, the AVA prompts, the AVA name and version, and every tool call with its status and latency. Tool inputs and outputs are not included.',
              reference: 'GET /api/v2/analytics/botflows/{botFlowId}/divisions/reportingturns',
            },
          ]}
        />

        {turnSessions.state === 'unavailable' ? (
          <div className="timeline-notice is-warning">
            <strong>Turn sweep sessions are temporarily unavailable.</strong>
            Sessions recorded only by the server-side sweep are missing from this list until the
            store can be reached again.
          </div>
        ) : null}

        <Card
          title="AVA sessions"
          subtitle={
            turnSessions.state === 'ready'
              ? `${sessions.length} sessions · ${turnOnly} known only from reporting turns`
              : `${sessions.length} sessions`
          }
        >
          {sessions.length > 0 ? (
            <DataTable label="AVA sessions">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Started</th>
                    <th scope="col">Flow</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Category</th>
                    <th scope="col" className="num">
                      Turns
                    </th>
                    <th scope="col" className="num">
                      Tool calls
                    </th>
                    <th scope="col">Fidelity</th>
                    <th scope="col">Session</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.sessionId}>
                      <td>{formatDateTime(session.dateCreated)}</td>
                      <td>{session.flowName ?? <ShortId id={session.flowId} />}</td>
                      <td>
                        <Pill tone={outcomeTone(session.botResultCategory)}>
                          {session.botResult ?? 'Unknown'}
                        </Pill>
                      </td>
                      <td>
                        {session.source === 'capture' ? (
                          <Pill tone="neutral">Jobs capture</Pill>
                        ) : session.source === 'turns' ? (
                          <Pill tone="neutral">Turn sweep</Pill>
                        ) : (
                          (session.botResultCategory ?? '—')
                        )}
                      </td>
                      <td className="num">{session.turnCount}</td>
                      <td className="num">{session.toolCallCount || '—'}</td>
                      <td>
                        {session.retrievalStatus === 'ARCHIVED' ? (
                          <Pill tone="good">Full trace</Pill>
                        ) : session.turnEvidence ? (
                          <Pill tone="info">Turn metadata</Pill>
                        ) : session.retrievalStatus === 'NO_HISTORY' ? (
                          <Pill tone="warn">No history</Pill>
                        ) : session.retrievalStatus ? (
                          <Pill tone={retrievalTone(session.retrievalStatus)}>Analytics only</Pill>
                        ) : (
                          <Pill tone="neutral">Pending</Pill>
                        )}
                      </td>
                      <td>
                        <ShortId id={session.sessionId} href={`/sessions/${session.sessionId}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTable>
          ) : (
            <Empty title="No sessions in this window">
              Start Live capture and complete one of the selected flows. The session will appear
              here after its execution-history job finishes.
            </Empty>
          )}
        </Card>
      </div>
    </>
  );
}
