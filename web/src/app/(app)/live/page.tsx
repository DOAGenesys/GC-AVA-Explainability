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
          summary="The browser listens for exact execution pointers; the server retrieves and archives the corresponding traces with the signed-in user's Genesys access."
          assets={[
            {
              name: 'OAuth + protected app routes',
              role: 'Authorization Code with PKCE keeps the user token encrypted in an HttpOnly cookie; POST routes also require CSRF validation.',
              reference: '/api/notifications/channel · /api/capture/executions',
            },
            {
              name: 'Notifications channel',
              role: 'Creates one temporary channel, then subscribes to concrete flow topics over its WebSocket—subscription messages add no second Platform API call.',
              reference: 'POST /api/v2/notifications/channels',
            },
            {
              name: 'Flow-instance topic',
              role: 'Emits executionId, flowId, and conversationId so capture needs no conversation or execution discovery.',
              reference: 'v2.flows.instances.flow.{id}',
            },
            {
              name: 'Jobs batch + download',
              role: 'Buffers at most 10 IDs for 30 seconds, creates and polls one Jobs request, then fetches pre-signed trace payloads from the regional download host.',
              reference: 'POST + GET /api/v2/flows/instances/jobs',
            },
            {
              name: 'Postgres archive',
              role: 'Atomically claims IDs, deduplicates notifications, and persists executions, projected sessions, flattened tool calls, and API-cost runs.',
              reference: 'ava_executions · ava_sessions · ava_tool_calls · ingest_runs',
            },
          ]}
        />
        <NotificationStream flowOptions={flowOptions} />
      </div>
    </>
  );
}
