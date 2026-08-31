import Link from 'next/link';
import { ToolBars } from '@/components/charts';
import { DataTable } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { Card, Empty, Kpi } from '@/components/ui';
import { getReadiness } from '@/server/config';
import { getDatabaseStatus, getOverviewMetrics, getToolStats } from '@/server/db';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 7;

export default async function DashboardPage() {
  const readiness = getReadiness();
  if (!readiness.databaseConfigured) return <NotConfigured missing={readiness.missing} />;

  const status = await getDatabaseStatus();
  if (status.state === 'schema-missing') return <SchemaMissing missing={status.missingTables} />;
  if (status.state === 'unreachable') return <DatabaseUnreachable />;

  const [metrics, tools] = await Promise.all([
    getOverviewMetrics(WINDOW_DAYS),
    getToolStats(WINDOW_DAYS),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="AVA observability"
        description={
          <>
            Completed flow events provide execution, flow and conversation IDs in real time. The
            archive sends those execution IDs directly to Jobs in batches of ten—without discovery
            queries or scheduled polling.
          </>
        }
        action={
          <Link className="btn-link-primary" href="/live">
            Start live capture
          </Link>
        }
      />

      <div className="stack">
        <div className="grid grid-kpi">
          <Kpi
            label="Full traces"
            value={metrics.executionsArchived.toLocaleString()}
            note={`Captured in the last ${WINDOW_DAYS} days`}
          />
          <Kpi
            label="Tool calls"
            value={metrics.toolCalls.toLocaleString()}
            note={`${metrics.toolFailures.toLocaleString()} took a failure path`}
            accent={metrics.toolFailures > 0}
          />
          <Kpi
            label="Truncated traces"
            value={metrics.truncatedTraces.toLocaleString()}
            note="Reported directly by Genesys"
            accent={metrics.truncatedTraces > 0}
          />
          <Kpi
            label="No history"
            value={metrics.executionsNoHistory.toLocaleString()}
            note="Confirmed 404 responses"
          />
          <Kpi
            label="Platform API calls, 24h"
            value={metrics.apiCalls24h.toLocaleString()}
            note="Downloads excluded from API allowance"
          />
          <Kpi
            label="API calls / execution"
            value={metrics.apiCallsPerExecution?.toFixed(3) ?? '—'}
            note="0.2 at a full batch of ten"
            accent={metrics.apiCallsPerExecution != null && metrics.apiCallsPerExecution > 0.5}
          />
        </div>

        <div className="capture-overview">
          <div>
            <span>01</span>
            <strong>Listen</strong>
            <p>Choose one or many flow IDs and open a temporary Genesys notification channel.</p>
          </div>
          <div>
            <span>02</span>
            <strong>Batch</strong>
            <p>Execution pointers collect up to the measured ten-ID Jobs API ceiling.</p>
          </div>
          <div>
            <span>03</span>
            <strong>Explain</strong>
            <p>Full traces and tool calls are archived, flattened and ready for analysis.</p>
          </div>
          <Link href="/live">
            <span aria-hidden="true">●</span>
            Open capture studio
          </Link>
        </div>

        {metrics.executionsNoHistory > 0 ? (
          <div className="callout alert">
            <strong>
              {metrics.executionsNoHistory.toLocaleString()} execution
              {metrics.executionsNoHistory === 1 ? ' has' : 's have'} no retrievable history.
            </strong>
            Genesys confirmed these with a 404. They are terminal outcomes and will not consume
            budget again.
          </div>
        ) : null}

        <Card
          title="Tool activity"
          subtitle="Data action calls extracted from captured execution history"
          action={<Link href="/tools">Explore tool performance</Link>}
        >
          {tools.length > 0 ? (
            <ToolBars data={tools.slice(0, 12)} />
          ) : (
            <Empty title="No tool calls archived yet">
              Start live capture, then complete a selected flow. Its trace will be retrieved and
              tool calls will appear here automatically.
            </Empty>
          )}
        </Card>
      </div>
    </>
  );
}

function NotConfigured({ missing }: { missing: string[] }) {
  return (
    <>
      <PageHeader
        eyebrow="Configuration"
        title="Finish setup"
        description="The app is deployed but cannot capture or display anything yet."
      />
      <Card title="Missing configuration">
        {missing.length > 0 ? (
          <DataTable label="Missing environment variables">
            <table>
              <thead>
                <tr>
                  <th scope="col">Environment variable</th>
                  <th scope="col">Needed for</th>
                </tr>
              </thead>
              <tbody>
                {missing.map((key) => (
                  <tr key={key}>
                    <td>
                      <code>{key}</code>
                    </td>
                    <td>{PURPOSE[key] ?? 'Application configuration'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
        ) : (
          <Empty title="Nothing missing">Configuration looks complete.</Empty>
        )}
      </Card>
    </>
  );
}

function SchemaMissing({ missing }: { missing: string[] }) {
  return (
    <>
      <PageHeader
        eyebrow="Database setup"
        title="Apply the database schema"
        description="Postgres is connected, but the observability tables have not been created."
      />
      <Card title="Run this once" subtitle="From the web directory, against this database">
        <pre className="code-block">
          <code>{'POSTGRES_URL="<this deployment\u2019s connection string>" npm run db:init'}</code>
        </pre>
        <p className="hint">
          The schema is idempotent, so re-running it is safe. Reload this page afterwards.
        </p>
      </Card>
      <Card title="Missing tables">
        <DataTable label="Missing database tables">
          <table>
            <thead>
              <tr>
                <th scope="col">Table</th>
              </tr>
            </thead>
            <tbody>
              {missing.map((table) => (
                <tr key={table}>
                  <td>
                    <code>{table}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
      </Card>
    </>
  );
}

function DatabaseUnreachable() {
  return (
    <>
      <PageHeader
        eyebrow="Connection issue"
        title="Database unreachable"
        description="The app is configured but could not open a connection to Postgres."
      />
      <Card title="What to check">
        <ul className="checklist">
          <li>
            <code>POSTGRES_URL</code> points at a running database.
          </li>
          <li>The database is not paused or sleeping.</li>
          <li>Any IP allow list permits connections from Vercel.</li>
        </ul>
      </Card>
    </>
  );
}

const PURPOSE: Record<string, string> = {
  APP_SESSION_SECRET: 'Signing the app session and encrypting Genesys tokens in the cookie',
  POSTGRES_URL: 'Storing captured execution traces and tool calls',
};
