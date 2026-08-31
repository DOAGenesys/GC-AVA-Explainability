import { DataTable } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
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
            Every AVA session in the last {WINDOW_DAYS} days, whether or not a full execution trace
            exists for it. Sessions marked &ldquo;analytics only&rdquo; are real conversations the
            AVA handled whose execution history the platform does not hold.
          </>
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
                    <td>{session.botResultCategory ?? '—'}</td>
                    <td className="num">{session.turnCount}</td>
                    <td className="num">{session.toolCallCount || '—'}</td>
                    <td>
                      {session.retrievalStatus === 'ARCHIVED' ? (
                        <Pill tone="good">Full trace</Pill>
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
            The triage pass populates this table every ten minutes.
          </Empty>
        )}
      </Card>
    </>
  );
}
