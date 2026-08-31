import type { Metadata } from 'next';
import { LoginForm } from '@/components/login-form';

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
        {/*
          Full-colour logo, per brand rules for light backgrounds. A plain <img> is deliberate:
          next/image cannot serve SVG without `dangerouslyAllowSVG`, which would let arbitrary SVG
          through the optimizer, and there is nothing to optimise in a vector logo.
        */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/brand/genesys-cloud-horizontal.svg"
          alt="Genesys Cloud"
          className="brand-logo"
          width={168}
          height={20}
        />

        <h1>AVA Observability</h1>
        <p>
          Sign in with Genesys Cloud using Authorization Code with PKCE. Your tokens are held only
          in an encrypted, HttpOnly cookie for this browser and are never written to storage.
        </p>

        {error ? (
          <div className="auth-error" role="alert">
            {error}
          </div>
        ) : null}

        <LoginForm next={params.next} />
      </div>
    </main>
  );
}
