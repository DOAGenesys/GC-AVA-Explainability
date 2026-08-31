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
      <NotificationStream flowOptions={flowOptions} />
    </>
  );
}
