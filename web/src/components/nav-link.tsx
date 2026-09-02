'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Sidebar link that marks itself current, so the active section is obvious at a glance. */
export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
  return (
    <Link href={href} aria-current={active ? 'page' : undefined}>
      <NavIcon href={href} />
      <span>{children}</span>
    </Link>
  );
}

function NavIcon({ href }: { href: string }) {
  const paths: Record<string, React.ReactNode> = {
    '/': (
      <>
        <rect x="3" y="3" width="7" height="7" rx="2" />
        <rect x="14" y="3" width="7" height="7" rx="2" />
        <rect x="3" y="14" width="7" height="7" rx="2" />
        <rect x="14" y="14" width="7" height="7" rx="2" />
      </>
    ),
    '/tools': (
      <>
        <path d="M14.7 6.3a4 4 0 0 0-5 5L3.5 17.5a2.1 2.1 0 0 0 3 3l6.2-6.2a4 4 0 0 0 5-5l-2.4 2.4-3-3 2.4-2.4Z" />
      </>
    ),
    '/sessions': (
      <>
        <path d="M21 12a8.5 8.5 0 0 1-9 8 10.7 10.7 0 0 1-4-.8L3 21l1.6-4.1A8 8 0 1 1 21 12Z" />
        <path d="M8 12h.01M12 12h.01M16 12h.01" />
      </>
    ),
    '/reporting-turns': (
      <>
        <path d="M4 5h16M4 12h10M4 19h7" />
        <circle cx="18" cy="17" r="3" />
        <path d="m20.2 19.2 1.8 1.8" />
      </>
    ),
    '/live': (
      <>
        <path d="M5.6 8.5a5 5 0 0 0 0 7M2.8 5.7a9 9 0 0 0 0 12.6M18.4 8.5a5 5 0 0 1 0 7M21.2 5.7a9 9 0 0 1 0 12.6" />
        <circle cx="12" cy="12" r="2.2" />
      </>
    ),
    '/coverage': (
      <>
        <path d="M4 19V9M10 19V5M16 19v-7M22 19V3" />
        <path d="M2 19h22" />
      </>
    ),
    '/budget': (
      <>
        <path d="M12 2v20M17 6.5c0-1.7-2-3-5-3s-5 1.3-5 3 1.6 2.7 5 3 5 1.3 5 3-2 3-5 3-5-1.3-5-3" />
      </>
    ),
  };

  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[href]}
    </svg>
  );
}
