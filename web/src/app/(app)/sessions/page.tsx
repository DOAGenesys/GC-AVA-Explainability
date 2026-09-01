import Link from 'next/link';
import { DataTable } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { SessionsRefreshControl } from '@/components/sessions-refresh-control';
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
            Start Live capture and complete one of the selected flows. The session will appear here
            after its execution-history job finishes.
          </Empty>
        )}
      </Card>
    </>
  );
}
