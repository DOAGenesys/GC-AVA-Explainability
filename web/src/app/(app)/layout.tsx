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
          <span className="brand-mark">g</span>
          <span className="brand-text">
            <strong>AVA Observability</strong>
            <span>Genesys Cloud</span>
          </span>
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
