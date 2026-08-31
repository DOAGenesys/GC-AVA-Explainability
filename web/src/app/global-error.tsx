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
        <main className="login-wrap global-error-wrap">
          <section className="login-card global-error-card">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/brand/genesys-logo.svg"
              alt="Genesys"
              className="brand-logo"
              width={160}
              height={30}
            />
            <span className="state-code">Application error</span>
            <h1>The application failed to start</h1>
            <p className="login-lede">
              A required environment variable may be missing or malformed. Verify{' '}
              <code>APP_SESSION_SECRET</code>, <code>GENESYS_REGION</code> and{' '}
              <code>POSTGRES_URL</code> for this environment.
            </p>
            {error.digest ? (
              <p className="hint">
                Log digest: <code>{error.digest}</code>
              </p>
            ) : null}
            <button className="btn-primary" type="button" onClick={reset}>
              Reload application
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
