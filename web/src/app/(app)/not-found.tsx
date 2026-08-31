import Link from 'next/link';
import { PageHeader } from '@/components/page-header';

export default function AppNotFound() {
  return (
    <div className="state-page">
      <span className="state-code">404 · Not found</span>
      <PageHeader
        eyebrow="Navigation"
        title="This page is not in the archive"
        description="The session may have expired, the address may be incomplete, or this resource is no longer available."
      />
      <div className="state-actions">
        <Link className="btn-link-primary" href="/sessions">
          Browse sessions
        </Link>
        <Link className="btn-link-secondary" href="/">
          Return to dashboard
        </Link>
      </div>
    </div>
  );
}
