import { LatencyBars, ToolBars } from '@/components/charts';
import { DataTable } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { TechnicalAssets } from '@/components/technical-assets';
import { Card, Empty, Kpi, Pill, formatMs, formatPercent } from '@/components/ui';
import { getToolStats } from '@/server/db';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 7;

/**
 * Tool performance.
 *
 * This is the view that only execution history can produce. Analytics tells you a session ended in
 * a transfer; only the trace tells you the AVA called an order-lookup tool, got a failure path back,
 * and gave up - which is the difference between knowing the outcome and being able to fix it.
 */
export default async function ToolsPage() {
  const tools = await getToolStats(WINDOW_DAYS);

  const totalCalls = tools.reduce((sum, t) => sum + t.calls, 0);
  const totalFailures = tools.reduce((sum, t) => sum + t.failures, 0);
  const worst = [...tools]
    .filter((t) => t.calls >= 3)
    .sort((a, b) => b.failures / b.calls - a.failures / a.calls)[0];

  return (
    <>
      <PageHeader
        eyebrow="Execution intelligence"
        title="Tool performance"
        description={
          <>
            Data action calls the AVA chose to make, over the last {WINDOW_DAYS} days. A
            &ldquo;failure&rdquo; here means the call took its failure output path, which is what
            the model actually saw - independent of whether the underlying HTTP request looked
            healthy.
          </>
        }
      />

      <div className="stack">
        <TechnicalAssets
          summary="Tool evidence comes from downloadable execution history returned by the Jobs API, not from conversation or bot-flow analytics."
          assets={[
            {
              name: 'Notification pointer',
              role: 'The flow topic supplies the execution ID needed to request the trace containing its data-action activity.',
              reference: 'v2.flows.instances.flow.{id}',
            },
            {
              name: 'Bulk Jobs request',
              role: 'Retrieves histories asynchronously in groups of up to 10 execution IDs rather than making one Platform API request per execution.',
              reference: 'POST /api/v2/flows/instances/jobs · GET …/jobs/{jobId}',
            },
            {
              name: 'Execution-history payload',
              role: 'The per-execution download records tool name, timing, inputs, outputs, and the success or failure path selected by the AVA.',
              reference: 'job result entity → downloadUri',
            },
          ]}
        />

        <div className="grid grid-kpi">
          <Kpi label="Distinct tools" value={tools.length} />
          <Kpi label="Calls" value={totalCalls.toLocaleString()} />
          <Kpi
            label="Failure rate"
            value={formatPercent(totalCalls > 0 ? totalFailures / totalCalls : null)}
            note={`${totalFailures.toLocaleString()} calls took a failure path`}
            accent={totalFailures > 0}
          />
          <Kpi
            label="Least reliable tool"
            value={worst ? formatPercent(worst.failures / worst.calls) : '—'}
            note={worst?.toolName ?? 'Nothing with enough volume yet'}
            accent={Boolean(worst && worst.failures > 0)}
          />
        </div>

        {tools.length === 0 ? (
          <Card>
            <Empty title="No tool calls recorded yet">
              Tool detail appears after Live capture receives a completed flow event and archives
              its execution history.
            </Empty>
          </Card>
        ) : (
          <>
            <div className="grid grid-2">
              <Card title="Call volume and failures">
                <ToolBars data={tools.slice(0, 12)} />
              </Card>
              <Card
                title="Latency"
                subtitle="Measured from each AVA tool's recorded start and end timestamps"
              >
                <LatencyBars data={tools.slice(0, 12)} />
              </Card>
            </div>

            <Card title="All tools">
              <DataTable label="All tool performance metrics">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Tool</th>
                      <th scope="col" className="num">
                        Calls
                      </th>
                      <th scope="col" className="num">
                        Failures
                      </th>
                      <th scope="col" className="num">
                        Failure rate
                      </th>
                      <th scope="col" className="num">
                        Median
                      </th>
                      <th scope="col" className="num">
                        95th percentile
                      </th>
                      <th scope="col">Health</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tools.map((tool) => {
                      const rate = tool.calls > 0 ? tool.failures / tool.calls : 0;
                      return (
                        <tr key={tool.toolName}>
                          <td>{tool.toolName}</td>
                          <td className="num">{tool.calls.toLocaleString()}</td>
                          <td className="num">{tool.failures.toLocaleString()}</td>
                          <td className="num">{formatPercent(rate)}</td>
                          <td className="num">{formatMs(tool.p50LatencyMs)}</td>
                          <td className="num">{formatMs(tool.p95LatencyMs)}</td>
                          <td>
                            {rate === 0 ? (
                              <Pill tone="good">Healthy</Pill>
                            ) : rate < 0.1 ? (
                              <Pill tone="warn">Intermittent</Pill>
                            ) : (
                              <Pill tone="bad">Failing</Pill>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </DataTable>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
