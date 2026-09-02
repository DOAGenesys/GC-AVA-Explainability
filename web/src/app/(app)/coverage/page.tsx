import Link from 'next/link';
import { DataTable } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { TechnicalAssets } from '@/components/technical-assets';
import { Card, Empty, Kpi, Pill, ShortId, formatPercent } from '@/components/ui';
import { getCaptureCoverage } from '@/server/db';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 7;

export default async function CoveragePage() {
  const report = await getCaptureCoverage(WINDOW_DAYS);
  const archiveRate = report.observed > 0 ? report.archived / report.observed : null;

  return (
    <>
      <PageHeader
        eyebrow="Assurance"
        title="Capture coverage"
        description={
          <>
            Retrieval outcomes for executions observed while Live capture was active. This view
            deliberately makes no claim about executions that happened while no browser was
            listening.
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
          summary="Coverage compares flow-instance events received through active notification topics with the individual outcomes returned by the bulk Jobs API."
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
          all org executions. Within that population, every valid event goes directly to Jobs with
          no discovery call.
        </div>

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
