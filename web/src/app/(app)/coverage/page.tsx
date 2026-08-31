import { CoverageBars } from '@/components/charts';
import { Card, Empty, Kpi, formatPercent } from '@/components/ui';
import { getCoverageReport } from '@/server/db';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 7;

/**
 * The honesty page.
 *
 * Every observability tool is tempted to report what it can see as though it were everything that
 * happened. For AVA that would be actively misleading: execution history exists only for
 * executions that reach their flow's exit, and on the flow this architecture was validated against
 * that was one session in seven. This view states the shortfall as a number so nobody reads a
 * tool-call chart as a complete account of what the AVA did.
 */
export default async function CoveragePage() {
  const report = await getCoverageReport(WINDOW_DAYS);

  const fullFidelityRate =
    report.sessions > 0 ? report.sessionsWithExecution / report.sessions : null;
  const transcriptRate = report.sessions > 0 ? report.sessionsWithTurns / report.sessions : null;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Coverage</h1>
          <p>
            How much of what the AVA actually did is visible, and at what fidelity. The gap is not a
            defect in the ingestion - it is a property of the platform, and it is why the cheap
            analytics endpoints are the spine of this archive rather than an optimisation on top of
            execution history.
          </p>
        </div>
      </header>

      <div className="stack">
        <div className="grid grid-kpi">
          <Kpi
            label="Sessions observed"
            value={report.sessions.toLocaleString()}
            note={`Last ${WINDOW_DAYS} days`}
          />
          <Kpi
            label="Transcript coverage"
            value={formatPercent(transcriptRate)}
            note="Turn-level record captured"
          />
          <Kpi
            label="Full-trace coverage"
            value={formatPercent(fullFidelityRate)}
            note="Tool-level execution history retrieved"
          />
          <Kpi
            label="Analytics only"
            value={report.sessionsWithoutExecution.toLocaleString()}
            note="No execution trace will ever exist"
            accent={report.sessionsWithoutExecution > 0}
          />
        </div>

        <div className="callout">
          <strong>Why the two numbers differ</strong>
          Bot flow analytics records a session as soon as a conversation reaches the flow. Execution
          history is only written when an execution terminates by reaching its flow&apos;s exit. A
          conversation the customer abandoned, or one whose flow has no exit path after the AVA
          responds, produces a session and a transcript but no execution history at all - and the
          Jobs API answers 404 for it permanently rather than transiently.{' '}
          {report.sessionsWithNoHistory > 0 ? (
            <>
              {report.sessionsWithNoHistory.toLocaleString()} session
              {report.sessionsWithNoHistory === 1 ? ' has' : 's have'} been confirmed in that state
              by an actual Jobs response, rather than merely being unresolved.
            </>
          ) : null}
        </div>

        <Card title="Fidelity by outcome" subtitle="Which kinds of conversation lose their trace">
          {report.byCategory.length > 0 ? (
            <>
              <CoverageBars data={report.byCategory} />
              <div className="legend">
                <span>
                  <i className="swatch" style={{ background: '#18caa8' }} /> Full trace: transcript
                  plus tool-level execution history
                </span>
                <span>
                  <i className="swatch" style={{ background: '#ff451a' }} /> Analytics only:
                  transcript and outcome, no tool detail
                </span>
              </div>
            </>
          ) : (
            <Empty title="No sessions in this window" />
          )}
        </Card>

        <Card title="What to do about the gap">
          <table>
            <thead>
              <tr>
                <th>Observation</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>No session anywhere has a trace</td>
                <td>
                  Discovery returns an empty result rather than an error for every possible cause,
                  so check them in order: execution data enabled under Admin → Organization Settings
                  → Settings → Execution Data, no per-flow override turning it back off, the flow
                  republished after it was enabled since capture is never backfilled, and the ingest
                  credential holding Architect → Flow Instance → View and Search for the flow&apos;s
                  division. A credential missing either permission is shown zero instances rather
                  than being refused.
                </td>
              </tr>
              <tr>
                <td>A flow shows a persistently low full-trace rate</td>
                <td>
                  Check the flow design for a missing exit path after the AVA response. An execution
                  that never terminates never produces history, so this is fixable in Architect
                  rather than here.
                </td>
              </tr>
              <tr>
                <td>Sessions categorised as customer disconnect lack traces</td>
                <td>
                  Expected and not fixable. Rely on the transcript, which is captured for these.
                </td>
              </tr>
              <tr>
                <td>Transcript coverage below full</td>
                <td>
                  Ingestion is falling behind the upstream 10-day retention window. Check the cron
                  history on the API budget view - anything missed past that window is gone.
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
