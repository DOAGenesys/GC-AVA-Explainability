'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CSRF_COOKIE, CSRF_HEADER } from '@/server/auth/cookies';

type RefreshPass = 'triage' | 'fidelity';
type RefreshState = 'idle' | RefreshPass | 'done' | 'error';

function csrfToken(): string | null {
  const prefix = `${CSRF_COOKIE}=`;
  const cookie = document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : null;
}

async function runPass(pass: RefreshPass, token: string): Promise<void> {
  const response = await fetch('/api/ingest/refresh', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [CSRF_HEADER]: token,
    },
    body: JSON.stringify({ pass }),
  });

  if (response.ok) return;

  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string; nextAction?: string };
  } | null;
  const message = body?.error?.message ?? `The ${pass} pass failed (HTTP ${response.status}).`;
  const nextAction = body?.error?.nextAction;
  throw new Error(nextAction ? `${message} ${nextAction}` : message);
}

/**
 * Pull fresh Genesys data immediately, without waiting for Vercel Cron.
 *
 * The two passes use separate requests so each gets its own function-duration allowance. Triage
 * walks all AVA flows and can already be long-running; putting fidelity in the same invocation
 * would turn a healthy refresh into a timeout on a sufficiently busy org.
 */
export function RefreshDataButton() {
  const router = useRouter();
  const [state, setState] = useState<RefreshState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isRendering, startTransition] = useTransition();
  const busy = state === 'triage' || state === 'fidelity' || isRendering;

  async function refresh() {
    const token = csrfToken();
    if (!token) {
      setState('error');
      setError('The security token is missing. Reload the page and try again.');
      return;
    }

    setError(null);
    try {
      setState('triage');
      await runPass('triage', token);
      setState('fidelity');
      await runPass('fidelity', token);
      setState('done');
      startTransition(() => router.refresh());
    } catch (cause) {
      setState('error');
      setError(cause instanceof Error ? cause.message : 'The refresh failed.');
      // Triage may have succeeded even when fidelity did not, so still show any data it archived.
      startTransition(() => router.refresh());
    }
  }

  const label =
    state === 'triage'
      ? 'Fetching sessions and turns…'
      : state === 'fidelity'
        ? 'Fetching execution traces…'
        : isRendering
          ? 'Updating dashboard…'
          : 'Fetch latest data';

  return (
    <div className="refresh-control">
      <button
        className="btn-refresh"
        type="button"
        onClick={refresh}
        disabled={busy}
        aria-describedby="refresh-status"
      >
        <span className={busy ? 'refresh-icon is-spinning' : 'refresh-icon'} aria-hidden="true">
          ↻
        </span>
        {label}
      </button>
      <span
        id="refresh-status"
        className={error ? 'refresh-status is-error' : 'refresh-status'}
        aria-live="polite"
      >
        {error ??
          (state === 'done' ? 'Latest available data loaded.' : 'Runs both ingestion passes.')}
      </span>
    </div>
  );
}
