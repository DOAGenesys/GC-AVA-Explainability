import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { LoginForm } from '@/components/login-form';
import { getServerConfig } from '@/server/config';

export const metadata: Metadata = { title: 'Sign in | AVA Observability' };
export const dynamic = 'force-dynamic';

const AUTH_ERRORS: Record<string, string> = {
  APP_UNAUTHENTICATED: 'The sign-in attempt could not be verified. Please start again.',
  APP_BAD_REQUEST: 'Enter both a Genesys region and an OAuth Client ID.',
  GENESYS_AUTH_FAILED:
    'Genesys rejected the sign-in. Check that the Client ID is a Code Authorization client whose redirect URI matches this app.',
  GENESYS_NOT_CONFIGURED: 'Genesys sign-in is not connected yet.',
};

/**
 * The callback URL shown in the Client ID help, derived from the forwarded headers rather than
 * `window.location`. It must be byte-identical to the `redirect_uri` the server later sends to
 * Genesys, because a mismatch is rejected — so both are computed from the same request origin.
 */
async function callbackUrl(): Promise<string> {
  const h = await headers();
  const proto = h.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
  const host = h.get('x-forwarded-host')?.split(',')[0]?.trim() || h.get('host') || '';
  return `${proto}://${host}/api/auth/callback`;
}

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
  const cfg = getServerConfig();

  // GENESYS_REGION is the ingestion region and only seeds the field: whatever the user last used
  // on this browser wins, and they can always type a different one.
  const defaultRegion = cfg.ingestion.regionHost?.replace(/^api\./, '') ?? '';

  return (
    <main className="login-wrap">
      <div className="login-card">
        <div className="brand-lockup">
          {/*
            Flagship Genesys logo, full colour for a light background. A plain <img> is deliberate:
            next/image cannot serve SVG without `dangerouslyAllowSVG`, which would let arbitrary
            SVG through the optimizer, and a vector logo has nothing to optimise.
          */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/brand/genesys-logo.svg"
            alt="Genesys"
            className="brand-logo"
            width={200}
            height={37}
          />
        </div>

        {/* Kept as separate eyebrow text: brand rules forbid appending anything to the wordmark. */}
        <p className="eyebrow">Genesys Cloud</p>
        <h1>AVA Observability</h1>
        <p className="login-lede">
          Sign in with Authorization Code and PKCE. Your tokens are held only in an encrypted,
          HttpOnly cookie for this browser and are never written to storage.
        </p>

        {error ? (
          <div className="auth-error" role="alert">
            {error}
          </div>
        ) : null}

        <LoginForm
          next={params.next}
          defaultRegion={defaultRegion}
          callbackUrl={await callbackUrl()}
        />
      </div>
    </main>
  );
}
