import Link from 'next/link';
import { OutcomeDonut, ToolBars } from '@/components/charts';
import { DataTable } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { RefreshDataButton } from '@/components/refresh-data-button';
import {
  Card,
  Empty,
  Kpi,
  Pill,
  ShortId,
  formatDateTime,
  formatPercent,
  outcomeTone,
  retrievalTone,
} from '@/components/ui';
import { getReadiness } from '@/server/config';
import {
  getDatabaseStatus,
  getOutcomeBreakdown,
  getOverviewMetrics,
  getToolStats,
  listSessions,
} from '@/server/db';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 7;

export default async function DashboardPage() {
  const readiness = getReadiness();
  if (!readiness.databaseConfigured) return <NotConfigured missing={readiness.missing} />;

  const status = await getDatabaseStatus();
  if (status.state === 'schema-missing') return <SchemaMissing missing={status.missingTables} />;
  if (status.state === 'unreachable') return <DatabaseUnreachable />;

  const [metrics, outcomes, tools, sessions] = await Promise.all([
    getOverviewMetrics(WINDOW_DAYS),
    getOutcomeBreakdown(WINDOW_DAYS),
    getToolStats(WINDOW_DAYS),
    listSessions(WINDOW_DAYS, 8),
  ]);

  const traceCoverage = metrics.sessions > 0 ? metrics.executionsArchived / metrics.sessions : null;

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="AVA observability"
        description={
          <>
            Last {WINDOW_DAYS} days. Session outcomes and turn transcripts come from bot flow
            analytics; the tool-level detail comes from full execution history retrieved in batches
            of ten. The two do not cover the same conversations, which is what the coverage view is
            for.
          </>
        }
        action={<RefreshDataButton />}
      />

      <div className="stack">
        <div className="grid grid-kpi">
          <Kpi
            label="Sessions"
            value={metrics.sessions.toLocaleString()}
            note={`${metrics.conversations.toLocaleString()} distinct conversations`}
          />
          <Kpi
            label="Containment"
            value={formatPercent(metrics.containmentRate)}
            note="Handled without a human"
          />
          <Kpi
            label="Turns captured"
            value={metrics.turns.toLocaleString()}
            note="Durable copy of 10-day retention data"
          />
          <Kpi
            label="Full traces"
            value={metrics.executionsArchived.toLocaleString()}
            note={`${formatPercent(traceCoverage)} of sessions`}
          />
          <Kpi
            label="Tool calls"
            value={metrics.toolCalls.toLocaleString()}
            note={`${metrics.toolFailures.toLocaleString()} took a failure path`}
            accent={metrics.toolFailures > 0}
          />
          <Kpi
            label="API calls / execution"
            value={metrics.apiCallsPerExecution?.toFixed(2) ?? '—'}
            note="Measured ceiling is 0.2 at a full batch of ten"
          />
        </div>

        {metrics.executionsNoHistory > 0 ? (
          <div className="callout alert">
            <strong>
              {metrics.executionsNoHistory.toLocaleString()} executions have no history and never
              will.
            </strong>
            Genesys holds execution history only for executions that reach their flow&apos;s exit.
            These conversations happened and the AVA answered in them, but the Jobs API returns 404
            for them permanently, so the turn-level transcript captured by the triage pass is the
            only account of them that exists. <Link href="/coverage">See coverage</Link>.
          </div>
        ) : null}

        <div className="grid grid-2">
          <Card
            title="Session outcomes"
            subtitle="Classified by Genesys, one API call per flow per window"
          >
            {outcomes.length > 0 ? (
              <OutcomeDonut data={outcomes} />
            ) : (
              <Empty title="No sessions yet">
                The triage pass runs every ten minutes, or use Fetch latest data above to run it
                now.
              </Empty>
            )}
          </Card>

          <Card
            title="Tool activity"
            subtitle="Data action calls the AVA chose to make, from execution history"
          >
            {tools.length > 0 ? (
              <ToolBars data={tools.slice(0, 8)} />
            ) : (
              <Empty title="No tool calls recorded">
                Tool detail only exists inside execution history, so it appears once the fidelity
                pass retrieves an execution that reached its flow&apos;s exit. Fetch latest data
                runs that pass immediately after refreshing sessions and turns.
              </Empty>
            )}
          </Card>
        </div>

        <Card
          title="Recent sessions"
          subtitle="Newest first"
          action={<Link href="/sessions">View all</Link>}
        >
          {sessions.length > 0 ? (
            <DataTable label="Recent AVA sessions">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Started</th>
                    <th scope="col">Flow</th>
                    <th scope="col">Outcome</th>
                    <th scope="col" className="num">
                      Turns
                    </th>
                    <th scope="col" className="num">
                      Tools
                    </th>
                    <th scope="col">Trace</th>
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
                      <td className="num">{session.turnCount}</td>
                      <td className="num">{session.toolCallCount || '—'}</td>
                      <td>
                        {session.executionId ? (
                          <Pill tone={retrievalTone(session.retrievalStatus)}>
                            {session.retrievalStatus === 'ARCHIVED' ? 'Full' : 'Analytics only'}
                          </Pill>
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
            <Empty title="Nothing ingested yet">
              Confirm the cron jobs are running on the API budget view.
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
        description="The app is deployed but cannot ingest or display anything yet."
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
        description={
          <>
            Postgres is connected but the observability tables have not been created yet, so there
            is nothing to read from. This is a one-off step per database.
          </>
        }
      />
      <Card title="Run this once" subtitle="From the web directory, against this database">
        <pre className="code-block">
          <code>{'POSTGRES_URL="<this deployment\u2019s connection string>" npm run db:init'}</code>
        </pre>
        <p className="hint">
          Copy the connection string from the storage tab of your Vercel project. The script is
          idempotent, so re-running it is safe. Reload this page afterwards.
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
            <code>POSTGRES_URL</code> is set on this environment and points at a running database.
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
  GENESYS_INGEST_CLIENT_ID: 'Client-credentials identity used by the cron ingestion',
  GENESYS_INGEST_CLIENT_SECRET: 'Client-credentials identity used by the cron ingestion',
  GENESYS_REGION: 'Which Genesys region the ingestion talks to',
  CRON_SECRET: 'Authorising the Vercel cron routes',
  POSTGRES_URL: 'Storing the observability archive',
};
