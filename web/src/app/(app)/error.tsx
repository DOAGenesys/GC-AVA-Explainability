'use client';

import { Card } from '@/components/ui';
import { PageHeader } from '@/components/page-header';

/**
 * Route-level error boundary for the authenticated app.
 *
 * Next.js replaces server error messages with an opaque digest in production, so there is nothing
 * useful to show the reader beyond the digest itself - but showing that, plus a retry, is far better
 * than the framework's bare "a server error occurred" screen. The digest is the value to quote when
 * correlating against the runtime logs.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="state-page">
      <PageHeader
        eyebrow="Render error"
        title="Something failed on the server"
        description="This page could not be rendered. The rest of the app is unaffected."
      />
      <div className="state-card">
        <Card title="Most likely causes">
          <ul className="checklist">
            <li>
              The database schema has not been applied yet - run <code>npm run db:init</code>{' '}
              against this database.
            </li>
            <li>
              <code>POSTGRES_URL</code> is missing on this environment, or the database is paused.
            </li>
            <li>A transient connection failure, which usually clears on retry.</li>
          </ul>
          {error.digest ? (
            <p className="hint">
              Quote this digest when checking the runtime logs: <code>{error.digest}</code>
            </p>
          ) : null}
          <p className="error-actions">
            <button className="btn-primary" type="button" onClick={reset}>
              Try again
            </button>
          </p>
        </Card>
      </div>
    </div>
  );
}
