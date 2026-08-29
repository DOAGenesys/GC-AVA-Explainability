'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Sidebar link that marks itself current, so the active section is obvious at a glance. */
export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
  return (
    <Link href={href} aria-current={active ? 'page' : undefined}>
      {children}
    </Link>
  );
}
