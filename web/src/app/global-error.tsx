'use client';

import './globals.css';

/**
 * Last-resort boundary for failures in the root layout itself, where no other UI is mounted.
 *
 * This replaces the document, so it renders its own html/body and leans on inline styles rather
 * than assuming any layout chrome exists.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main
          style={{
            maxWidth: 560,
            margin: '18vh auto',
            padding: '0 24px',
            fontFamily: 'var(--sans, system-ui, sans-serif)',
          }}
        >
          <h1 style={{ fontSize: 22, marginBottom: 10 }}>The application failed to start</h1>
          <p style={{ color: 'var(--ink-muted, #55636f)', lineHeight: 1.55, marginBottom: 18 }}>
            This usually means a required environment variable is missing or malformed, so the app
            could not be constructed at all. Verify <code>APP_SESSION_SECRET</code>,{' '}
            <code>GENESYS_REGION</code> and <code>POSTGRES_URL</code> on this environment.
          </p>
          {error.digest ? (
            <p style={{ color: 'var(--ink-muted, #55636f)', fontSize: 13, marginBottom: 18 }}>
              Log digest: <code>{error.digest}</code>
            </p>
          ) : null}
          <button className="btn-primary" type="button" onClick={reset}>
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
