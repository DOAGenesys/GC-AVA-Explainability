import Link from 'next/link';
import { getServerConfig } from '@/server/config';
import { currentGenesysIdentity } from '@/server/genesys/oauth';
import { NavLink } from '@/components/nav-link';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const identity = await currentGenesysIdentity();
  const cfg = getServerConfig();

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link href="/" className="brand">
          {/* White-wordmark logo, per brand rules for Navy backgrounds. Plain <img> for the same
              reason as on the sign-in page: SVG needs no optimizer. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/brand/genesys-logo-white.svg"
            alt="Genesys"
            className="brand-logo"
            width={150}
            height={28}
          />
          <span className="brand-product">
            <span className="brand-dot" aria-hidden="true" />
            AVA Observability
          </span>
        </Link>

        <nav className="nav" aria-label="Primary navigation">
          <span className="nav-label">Overview</span>
          <NavLink href="/">Dashboard</NavLink>
          <NavLink href="/tools">Tool performance</NavLink>

          <span className="nav-label">Explainability</span>
          <NavLink href="/sessions">Sessions</NavLink>
          <NavLink href="/live">Live capture</NavLink>

          <span className="nav-label">Assurance</span>
          <NavLink href="/coverage">Coverage</NavLink>
          <NavLink href="/budget">API budget</NavLink>
        </nav>

        <div className="sidebar-foot">
          <div className="identity">
            <span className="identity-avatar" aria-hidden="true">
              {(identity?.username ?? 'N').slice(0, 1).toUpperCase()}
            </span>
            <div className="identity-copy">
              {identity ? (
                <>
                  <strong>{identity.username}</strong>
                  <span>{identity.regionHost}</span>
                </>
              ) : (
                <span>Not connected</span>
              )}
            </div>
          </div>
          <div className="environment">
            <span className="status-dot" aria-hidden="true" />
            {cfg.environmentLabel} &middot; v{cfg.appVersion}
          </div>
          <form method="POST" action="/api/auth/logout">
            <button type="submit">
              <span>Sign out</span>
              <span aria-hidden="true">↗</span>
            </button>
          </form>
        </div>
      </aside>

      <main className="main" id="main-content">
        <div className="main-inner">{children}</div>
      </main>
    </div>
  );
}
