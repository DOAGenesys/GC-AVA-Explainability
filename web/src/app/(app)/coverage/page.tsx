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
          summary="Coverage is measured only inside the population of valid flow-instance notifications received while a browser channel was live."
          assets={[
            {
              name: 'Observed population',
              role: 'Each valid topic event contributes one deduplicated execution ID; executions outside the active WebSocket window are intentionally unknown.',
              reference: 'v2.flows.instances.flow.{id}',
            },
            {
              name: 'Jobs outcome',
              role: 'Classifies each observed execution as archived, confirmed NO_HISTORY, retryable failure, or truncated from the actual retrieval result.',
              reference: 'POST + GET /api/v2/flows/instances/jobs',
            },
            {
              name: 'Capture-scoped report',
              role: 'Groups the stored execution statuses by flow without estimating organization-wide traffic.',
              reference: 'ava_executions · ingest_runs',
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
