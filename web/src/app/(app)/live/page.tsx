import { NotificationStream } from '@/components/notification-stream';
import { PageHeader } from '@/components/page-header';
import { listAvaFlowOptions } from '@/server/db';

export const dynamic = 'force-dynamic';

export default async function LiveEventsPage() {
  // Flow suggestions are a convenience, not a dependency of live notifications. The viewer still
  // works when the archive database is unavailable because users can paste a concrete flow id.
  const flowOptions = await listAvaFlowOptions().catch(() => []);

  return (
    <>
      <PageHeader
        eyebrow="Real-time diagnostics"
        title="Live Genesys events"
        description={
          <>
            Open a temporary WebSocket channel and inspect selected Genesys Cloud notifications as
            they happen. Events remain in this browser tab only; closing the page stops the live
            connection and nothing is written to the observability archive.
          </>
        }
      />
      <NotificationStream flowOptions={flowOptions} />
    </>
  );
}
