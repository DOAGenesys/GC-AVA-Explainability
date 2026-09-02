import { NotificationStream } from '@/components/notification-stream';
import { PageHeader } from '@/components/page-header';
import { TechnicalAssets } from '@/components/technical-assets';
import { listAvaFlowOptions } from '@/server/db';

export const dynamic = 'force-dynamic';

export default async function LiveEventsPage() {
  // Flow suggestions are a convenience, not a dependency of live notifications. The viewer still
  // works when the archive database is unavailable because users can paste a concrete flow id.
  const flowOptions = await listAvaFlowOptions().catch(() => []);

  return (
    <>
      <PageHeader
        eyebrow="Event-driven ingestion"
        title="Live execution capture"
        description={
          <>
            Subscribe to one or many AVA flows, capture each completed execution as it happens, and
            archive its full trace through the Jobs API. No conversation discovery calls and no
            scheduled polling.
          </>
        }
      />
      <div className="stack">
        <TechnicalAssets
          summary="The signed-in Genesys user opens a notification channel, subscribes to exact flow topics, and sends the resulting execution IDs to the bulk Jobs API."
          assets={[
            {
              name: 'Genesys OAuth',
              role: 'Authorization Code with PKCE supplies a user-context token, so division and API permissions match the signed-in Genesys user.',
              reference: 'OAuth 2.0 Authorization Code + PKCE',
            },
            {
              name: 'Notifications channel',
              role: 'One individual API request creates a temporary channel and returns the WebSocket connectUri used for the live stream.',
              reference: 'POST /api/v2/notifications/channels',
            },
            {
              name: 'Flow-instance topic',
              role: 'One concrete subscription is sent over the WebSocket for each selected flow; wildcards are not supported.',
              reference: 'v2.flows.instances.flow.{id}',
            },
            {
              name: 'Bulk execution-history job',
              role: 'Up to 10 execution IDs from topic events are submitted together as one asynchronous job, then that job is polled until complete.',
              reference: 'POST /api/v2/flows/instances/jobs · GET …/jobs/{jobId}',
            },
            {
              name: 'Per-execution downloads',
              role: 'The completed job returns one result per execution. Successful results provide a pre-signed downloadUri containing the full trace.',
              reference: 'job result entity → downloadUri',
            },
          ]}
        />
        <NotificationStream flowOptions={flowOptions} />
      </div>
    </>
  );
}
