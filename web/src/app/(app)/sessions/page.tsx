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
import { listSessions } from '@/server/db';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 7;

export default async function SessionsPage() {
  const sessions = await listSessions(WINDOW_DAYS, 300);

  return (
    <>
      <PageHeader
        eyebrow="Explainability"
        title="Sessions"
        description={
          <>
            AVA sessions observed in the last {WINDOW_DAYS} days. Live captures become available
            here as soon as their Jobs retrieval finishes; older analytics sessions remain visible
            alongside them.
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
          summary="Each Jobs-captured session starts with a flow notification and inherits the retrieval outcome returned for that notification’s execution ID."
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
          ]}
        />

        <Card>
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
                        ) : (
                          (session.botResultCategory ?? '—')
                        )}
                      </td>
                      <td className="num">{session.turnCount}</td>
                      <td className="num">{session.toolCallCount || '—'}</td>
                      <td>
                        {session.retrievalStatus === 'ARCHIVED' ? (
                          <Pill tone="good">Full trace</Pill>
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
