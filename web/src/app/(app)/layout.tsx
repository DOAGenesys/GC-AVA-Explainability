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
      <aside className="sidebar">
        <Link href="/" className="brand" style={{ color: 'inherit' }}>
          {/* White-wordmark logo, per brand rules for Navy backgrounds. Plain <img> for the same
              reason as on the sign-in page: SVG needs no optimizer. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/brand/genesys-cloud-horizontal-white.svg"
            alt="Genesys Cloud"
            className="brand-logo"
            width={158}
            height={19}
          />
          <span className="brand-product">AVA Observability</span>
        </Link>

        <nav className="nav">
          <span className="nav-label">Overview</span>
          <NavLink href="/">Dashboard</NavLink>
          <NavLink href="/tools">Tool performance</NavLink>

          <span className="nav-label">Explainability</span>
          <NavLink href="/sessions">Sessions</NavLink>

          <span className="nav-label">Assurance</span>
          <NavLink href="/coverage">Coverage</NavLink>
          <NavLink href="/budget">API budget</NavLink>
        </nav>

        <div className="sidebar-foot">
          <div>
            {identity ? (
              <>
                <div style={{ color: 'var(--gen-white)' }}>{identity.username}</div>
                <div>{identity.regionHost}</div>
              </>
            ) : (
              <div>Not connected</div>
            )}
          </div>
          <div style={{ opacity: 0.7 }}>
            {cfg.environmentLabel} &middot; v{cfg.appVersion}
          </div>
          <form method="POST" action="/api/auth/logout">
            <button type="submit">Sign out</button>
          </form>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}
