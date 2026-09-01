'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

const REFRESH_INTERVAL_MS = 10_000;

/** Keeps a Sessions tab current while Live capture is running in another browser tab. */
export function SessionsRefreshControl() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [autoRefresh, setAutoRefresh] = useState(true);

  const refresh = useCallback(() => {
    startTransition(() => router.refresh());
  }, [router]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, refresh]);

  return (
    <div className="sessions-refresh-control">
      <button className="btn-link-secondary" type="button" disabled={isPending} onClick={refresh}>
        {isPending ? 'Checking…' : 'Refresh sessions'}
      </button>
      <button
        className={autoRefresh ? 'auto-refresh-toggle is-on' : 'auto-refresh-toggle'}
        type="button"
        aria-pressed={autoRefresh}
        onClick={() => setAutoRefresh((current) => !current)}
      >
        <span aria-hidden="true" />
        Auto-refresh {autoRefresh ? 'on' : 'off'}
      </button>
    </div>
  );
}
