import { PageHeader } from '@/components/page-header';
import { ReportingTurnsExplorer } from '@/components/reporting-turns-explorer';
import { listAvaFlowOptions } from '@/server/db';

export const dynamic = 'force-dynamic';

export default async function ReportingTurnsPage() {
  // Suggestions come from the local archive, but querying only requires a concrete bot-flow ID.
  const flowOptions = await listAvaFlowOptions().catch(() => []);

  return (
    <>
      <PageHeader
        eyebrow="Bot Flows · analytics"
        title="Bot Flows - Reporting Turns"
        description={
          <>
            Inspect recent conversational evidence in bulk across a bot flow. This division-aware
            source explains what the user said, what the AVA answered, and which intent, knowledge,
            ask-action, or guardrail evidence shaped the outcome.
          </>
        }
      />
      <ReportingTurnsExplorer flowOptions={flowOptions} />
    </>
  );
}
