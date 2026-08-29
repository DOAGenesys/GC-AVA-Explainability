import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Sign in | AVA Observability' };

const AUTH_ERRORS: Record<string, string> = {
  APP_UNAUTHENTICATED: 'The sign-in attempt could not be verified. Please start again.',
  APP_BAD_REQUEST: 'Enter both a Genesys region and an OAuth Client ID.',
  GENESYS_AUTH_FAILED:
    'Genesys rejected the sign-in. Check that the Client ID is a Token Implicit or Code Authorization client whose redirect URI matches this app.',
  GENESYS_NOT_CONFIGURED: 'Genesys sign-in is not connected yet.',
};

/**
 * Sign-in. The app holds no interactive Genesys credentials of its own: the user brings their
 * region and OAuth client id, and everything they see afterwards is read with their own token and
 * their own permissions. Only the background ingestion runs under a separate service identity.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const error = params.auth_error ? AUTH_ERRORS[params.auth_error] : undefined;

  return (
    <main className="login-wrap">
      <div className="login-card">
        <div className="brand" style={{ marginBottom: 22 }}>
          <span className="brand-mark">g</span>
          <span className="brand-text">
            <strong style={{ color: 'var(--ink)' }}>AVA Observability</strong>
            <span style={{ color: 'var(--ink-faint)' }}>Genesys Cloud</span>
          </span>
        </div>

        <h1>Sign in with Genesys Cloud</h1>
        <p>
          Authorization Code with PKCE. Your tokens are held only in an encrypted, HttpOnly cookie
          for this browser and are never written to storage.
        </p>

        {error ? (
          <div className="auth-error" role="alert">
            {error}
          </div>
        ) : null}

        <form method="GET" action="/api/auth/login">
          {params.next ? <input type="hidden" name="next" value={params.next} /> : null}

          <div className="field">
            <label htmlFor="region">Genesys region</label>
            <input
              id="region"
              name="region"
              required
              placeholder="mypurecloud.de"
              autoComplete="off"
              spellCheck={false}
              defaultValue="mypurecloud.de"
            />
            <p className="field-hint">
              The region domain, for example mypurecloud.de or mypurecloud.com.
            </p>
          </div>

          <div className="field">
            <label htmlFor="clientId">OAuth Client ID</label>
            <input
              id="clientId"
              name="clientId"
              required
              placeholder="00000000-0000-0000-0000-000000000000"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="field-hint">
              A Code Authorization client whose redirect URI is this app&apos;s /api/auth/callback.
            </p>
          </div>

          <button className="btn-primary" type="submit">
            Continue to Genesys
          </button>
        </form>
      </div>
    </main>
  );
}
