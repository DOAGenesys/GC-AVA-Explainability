import { BudgetLine } from '@/components/charts';
import { DataTable } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { TechnicalAssets } from '@/components/technical-assets';
import { Card, Empty, Kpi, Pill, formatDateTime, formatMs } from '@/components/ui';
import { listCaptureRuns } from '@/server/db';

export const dynamic = 'force-dynamic';

/**
 * API budget and capture health.
 *
 * This page exists because the design rests on a measured number - ten execution ids per job, two
 * API calls per job, so 0.2 calls per execution - and a number nobody watches is a number that
 * quietly stops being true. Every capture batch records its own call count.
 */
export default async function BudgetPage() {
  const runs = await listCaptureRuns(120);

  // react-hooks/purity cannot yet tell a Server Component from a client one. This renders once per
  // request on the server, so there is no re-render for an unstable clock read to destabilise.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const last24h = runs.filter((r) => now - Date.parse(r.startedAt) < 86_400_000);
  const calls24h = last24h.reduce((sum, r) => sum + r.apiCalls, 0);
  const retrieved24h = last24h.reduce((sum, r) => sum + r.executionsRetrieved, 0);
  const rateLimited24h = last24h.reduce((sum, r) => sum + r.rateLimited, 0);
  const failures = runs.filter((r) => !r.ok).length;

  const ratios = runs
    .map((r) => r.apiCallsPerExecution)
    .filter((v): v is number => v != null && v > 0);
  const meanRatio = ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;

  const series = [...runs]
    .filter((r) => r.kind === 'capture')
    .reverse()
    .slice(-40)
    .map((r) => ({
      at: new Date(r.startedAt).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      }),
      apiCalls: r.apiCalls,
      perExecution: r.apiCallsPerExecution,
    }));

  return (
    <>
      <PageHeader
        eyebrow="Assurance"
        title="API budget"
        description={
          <>
            Capture cost, measured continuously. Content downloads are excluded on purpose: job
            payloads are served from the region&apos;s download host rather than the Platform API,
            so the bytes do not consume the API allowance. Only the calls counted here do.
          </>
        }
      />

      <div className="stack">
        <TechnicalAssets
          summary="Every capture batch carries its own measured API budget; this page reads those records rather than estimating cost from traffic."
          assets={[
            {
              name: 'Channel creation',
              role: 'Opening a temporary notification channel costs one Platform API call; WebSocket events and socket subscription messages do not.',
              reference: 'POST /api/v2/notifications/channels',
            },
            {
              name: 'Jobs accounting',
              role: 'Counts submit and poll attempts, retries, and 429 responses. A full 10-ID batch has a two-call floor, or 0.2 calls per execution.',
              reference: 'POST + GET /api/v2/flows/instances/jobs',
            },
            {
              name: 'Download boundary',
              role: 'Pre-signed trace downloads use the regional download host and are deliberately excluded from the Platform API allowance.',
              reference: 'api-downloads.{region}',
            },
            {
              name: 'Run ledger',
              role: 'Persists duration, retrieved and no-history counts, rate limits, failures, and calls per execution for every batch.',
              reference: 'ingest_runs · kind=capture',
            },
          ]}
        />

        <div className="grid grid-kpi">
          <Kpi
            label="API calls, 24h"
            value={calls24h.toLocaleString()}
            note={`${last24h.length} capture batches`}
          />
          <Kpi
            label="Executions retrieved, 24h"
            value={retrieved24h.toLocaleString()}
            note="Full traces archived"
          />
          <Kpi
            label="Mean calls / execution"
            value={meanRatio?.toFixed(3) ?? '—'}
            note="0.2 at a full batch of ten"
            accent={meanRatio != null && meanRatio > 0.5}
          />
          <Kpi
            label="Rate limited, 24h"
            value={rateLimited24h.toLocaleString()}
            note="429 responses honoured with Retry-After"
            accent={rateLimited24h > 0}
          />
          <Kpi
            label="Failed passes"
            value={failures.toLocaleString()}
            note="Of the last 120 runs"
            accent={failures > 0}
          />
        </div>

        {meanRatio != null && meanRatio > 0.5 ? (
          <div className="callout alert">
            <strong>Cost per execution is above the batched floor.</strong>A job costs the same two
            calls whether it carries one execution id or ten, so a ratio near 2.0 means batches are
            running nearly empty. Leave capture running across more flows, or allow the 30-second
            buffer to collect more execution events before using Archive pending now.
          </div>
        ) : null}

        <Card title="Capture cost over time" subtitle="Calls per run against calls per execution">
          {series.length > 0 ? (
            <BudgetLine data={series} />
          ) : (
            <Empty title="No capture batches recorded yet" />
          )}
        </Card>

        <Card title="Capture history" subtitle="Newest first">
          {runs.length > 0 ? (
            <DataTable label="Capture batch history">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Started</th>
                    <th scope="col">Mode</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">
                      Duration
                    </th>
                    <th scope="col" className="num">
                      API calls
                    </th>
                    <th scope="col" className="num">
                      Retrieved
                    </th>
                    <th scope="col" className="num">
                      No history
                    </th>
                    <th scope="col" className="num">
                      Calls / exec
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runs.slice(0, 60).map((run) => (
                    <tr key={run.id}>
                      <td>{formatDateTime(run.startedAt)}</td>
                      <td>{run.kind}</td>
                      <td>
                        {run.ok ? (
                          <Pill tone="good">OK</Pill>
                        ) : (
                          <Pill tone="bad">{run.error?.slice(0, 60) ?? 'Failed'}</Pill>
                        )}
                      </td>
                      <td className="num">{formatMs(run.durationMs)}</td>
                      <td className="num">{run.apiCalls}</td>
                      <td className="num">{run.executionsRetrieved || '—'}</td>
                      <td className="num">{run.executionsNoHistory || '—'}</td>
                      <td className="num">{run.apiCallsPerExecution?.toFixed(3) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTable>
          ) : (
            <Empty title="No capture has run yet">
              Open Live capture, choose at least one flow, and complete an execution.
            </Empty>
          )}
        </Card>
      </div>
    </>
  );
}
