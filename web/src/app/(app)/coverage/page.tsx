import Link from 'next/link';
import { DataTable } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { TechnicalAssets } from '@/components/technical-assets';
import { Card, Empty, Kpi, Pill, ShortId, formatDateTime, formatPercent } from '@/components/ui';
import { summarizeSweep } from '@/lib/turn-evidence';
import { getCaptureCoverage, listArchivedConversationIds } from '@/server/db';
import { listSweepStatus, listTurnSessions } from '@/server/turns/store';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 7;
const SWEEP_SESSION_LIMIT = 2000;

async function loadSweepCoverage() {
  const [sessions, status] = await Promise.all([
    listTurnSessions(WINDOW_DAYS, SWEEP_SESSION_LIMIT),
    listSweepStatus(),
  ]);
  if (sessions.state === 'not-configured' || status.state === 'not-configured') {
    return { state: 'not-configured' } as const;
  }
  if (sessions.state !== 'ready' || status.state !== 'ready') {
    return { state: 'unavailable' } as const;
  }
  const conversationIds = sessions.data
    .map((session) => session.conversationId)
    .filter((id): id is string => id !== null);
  const archived = await listArchivedConversationIds(conversationIds);
  return {
    state: 'ready',
    summary: summarizeSweep(sessions.data, status.data, archived),
    flows: status.data,
  } as const;
}

export default async function CoveragePage() {
  const [report, sweep] = await Promise.all([getCaptureCoverage(WINDOW_DAYS), loadSweepCoverage()]);
  const archiveRate = report.observed > 0 ? report.archived / report.observed : null;

  return (
    <>
      <PageHeader
        eyebrow="Assurance"
        title="Capture coverage"
        description={
          <>
            Retrieval outcomes for executions observed while Live capture was active, alongside the
            server-side turn sweep, which records every AVA session Genesys reports whether or not a
            browser was listening.
          </>
        }
        action={
          <Link className="btn-link-secondary" href="/live">
            Open live capture
          </Link>
        }
      />

      <div className="stack">
        <TechnicalAssets
          summary="Coverage compares flow-instance events received through active notification topics with the individual outcomes returned by the bulk Jobs API, and with the bot flow reporting turns persisted by the hourly sweep."
          assets={[
            {
              name: 'Notification scope',
              role: 'A temporary channel listens to one explicit topic per selected flow. There is no wildcard, and events outside the channel lifetime are not observed.',
              reference: 'POST /api/v2/notifications/channels · v2.flows.instances.flow.{id}',
            },
            {
              name: 'Bulk Jobs outcomes',
              role: 'One asynchronous job handles up to 10 observed IDs and returns a separate success, failure, statusCode, and downloadUri for each execution.',
              reference: 'POST /api/v2/flows/instances/jobs · GET …/jobs/{jobId}',
            },
            {
              name: 'History availability',
              role: 'A successful download is a full trace; 404 is NO_HISTORY; transport or job failures remain retryable; the payload itself declares truncation.',
              reference: 'job result + downloaded execution history',
            },
            {
              name: 'Bot flow reporting turns',
              role: 'Pulled hourly for every flow with agenticVirtualAgentEnabled, from a per-flow watermark, before the platform’s ~10 day retention expires. Includes sessions that never reached the flow’s exit.',
              reference:
                'GET /api/v2/flows?type=digitalbot|bot · GET /api/v2/analytics/botflows/{botFlowId}/divisions/reportingturns',
            },
          ]}
        />

        <div className="grid grid-kpi">
          <Kpi
            label="Executions observed"
            value={report.observed.toLocaleString()}
            note={`Last ${WINDOW_DAYS} days`}
          />
          <Kpi
            label="Archive rate"
            value={formatPercent(archiveRate)}
            note={`${report.archived.toLocaleString()} full traces`}
          />
          <Kpi
            label="No history"
            value={report.noHistory.toLocaleString()}
            note="Confirmed by Genesys 404"
          />
          <Kpi
            label="Retryable failures"
            value={report.failed.toLocaleString()}
            note="Jobs or download failures"
            accent={report.failed > 0}
          />
          <Kpi
            label="Truncated traces"
            value={report.truncated.toLocaleString()}
            note="Marked by Genesys"
            accent={report.truncated > 0}
          />
        </div>

        <div className="callout">
          <strong>What “coverage” means here</strong>
          WebSocket topics require explicit flow IDs and remain active only while the capture page
          is open. The observed count is therefore a measured capture population, not an estimate of
          all org executions. The turn sweep below is the server-side complement: it does not depend
          on a browser, and it sees sessions that produce no execution history at all.
        </div>

        <Card
          title="Server-side turn sweep"
          subtitle={`Sessions recorded by reporting turns, last ${WINDOW_DAYS} days`}
        >
          {sweep.state === 'ready' ? (
            <>
              <div className="grid grid-kpi">
                <Kpi
                  label="Sessions swept"
                  value={sweep.summary.sessions.toLocaleString()}
                  note={`${sweep.summary.turns.toLocaleString()} turns`}
                />
                <Kpi
                  label="Without a full trace"
                  value={sweep.summary.withoutTrace.toLocaleString()}
                  note="Not in this app’s archive"
                  accent={sweep.summary.withoutTrace > 0}
                />
                <Kpi
                  label="AVA tool calls"
                  value={sweep.summary.toolCalls.toLocaleString()}
                  note={`${sweep.summary.toolFailures.toLocaleString()} not successful`}
                  accent={sweep.summary.toolFailures > 0}
                />
                <Kpi
                  label="Flows swept"
                  value={sweep.summary.flows.toLocaleString()}
                  note={
                    sweep.summary.lastRunAt
                      ? `Last run ${formatDateTime(sweep.summary.lastRunAt)}`
                      : 'No run yet'
                  }
                />
                <Kpi
                  label="Flows needing attention"
                  value={sweep.summary.flowsWithIssues.toLocaleString()}
                  note="Errors or incomplete reads"
                  accent={sweep.summary.flowsWithIssues > 0}
                />
              </div>

              {sweep.flows.some((flow) => flow.lastRunTurns > 0 || flow.lastError) ? (
                <DataTable label="Turn sweep by flow">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Flow</th>
                        <th scope="col">Last run</th>
                        <th scope="col" className="num">
                          Turns
                        </th>
                        <th scope="col" className="num">
                          Sessions
                        </th>
                        <th scope="col">Health</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sweep.flows
                        .filter((flow) => flow.lastRunTurns > 0 || flow.lastError)
                        .map((flow) => (
                          <tr key={flow.flowId}>
                            <td>
                              <strong>{flow.flowName ?? 'Unnamed flow'}</strong>
                              <br />
                              <ShortId id={flow.flowId} />
                            </td>
                            <td>{formatDateTime(flow.lastRunAt)}</td>
                            <td className="num">{flow.lastRunTurns}</td>
                            <td className="num">{flow.lastRunSessions}</td>
                            <td>
                              {flow.lastError ? (
                                <Pill tone="bad">{flow.lastError}</Pill>
                              ) : flow.lastRunComplete ? (
                                <Pill tone="good">Up to date</Pill>
                              ) : (
                                <Pill tone="warn">Catching up</Pill>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </DataTable>
              ) : (
                <Empty title="No turns in the latest run">
                  Every AVA flow was read to its watermark and none reported new turns.
                </Empty>
              )}
            </>
          ) : sweep.state === 'not-configured' ? (
            <Empty title="Turn sweep not connected">
              Set AVA_TURNS_TABLE, AVA_TURNS_AWS_REGION and AVA_TURNS_ROLE_ARN to read the sweep
              through Vercel OIDC federation.
            </Empty>
          ) : (
            <Empty title="Turn sweep temporarily unavailable">
              The sweep store could not be reached. Its data is unaffected; reload to retry.
            </Empty>
          )}
        </Card>

        <Card title="Retrieval by flow" subtitle="Observed executions, newest seven-day window">
          {report.byFlow.length > 0 ? (
            <DataTable label="Capture coverage by flow">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Flow</th>
                    <th scope="col" className="num">
                      Observed
                    </th>
                    <th scope="col" className="num">
                      Archived
                    </th>
                    <th scope="col" className="num">
                      No history
                    </th>
                    <th scope="col" className="num">
                      Failed
                    </th>
                    <th scope="col">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byFlow.map((flow) => (
                    <tr key={flow.flowId}>
                      <td>
                        <strong>{flow.flowName ?? 'Unnamed flow'}</strong>
                        <br />
                        <ShortId id={flow.flowId} />
                      </td>
                      <td className="num">{flow.observed}</td>
                      <td className="num">{flow.archived}</td>
                      <td className="num">{flow.noHistory || '—'}</td>
                      <td className="num">{flow.failed || '—'}</td>
                      <td>
                        {flow.failed > 0 ? (
                          <Pill tone="bad">Needs retry</Pill>
                        ) : flow.archived > 0 ? (
                          <Pill tone="good">Healthy</Pill>
                        ) : (
                          <Pill tone="warn">No archive</Pill>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTable>
          ) : (
            <Empty title="No executions observed yet">
              Start Live capture and complete one of the selected flows.
            </Empty>
          )}
        </Card>
      </div>
    </>
  );
}
