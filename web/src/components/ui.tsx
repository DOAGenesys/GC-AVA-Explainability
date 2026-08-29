import Link from 'next/link';

/** Small presentational primitives shared by the dashboards. Server components, no interactivity. */

export function Kpi({
  label,
  value,
  note,
  accent = false,
}: {
  label: string;
  value: string | number;
  note?: string;
  accent?: boolean;
}) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className={accent ? 'kpi-value accent' : 'kpi-value'}>{value}</span>
      {note ? <span className="kpi-note">{note}</span> : null}
    </div>
  );
}

export function Card({
  title,
  subtitle,
  action,
  children,
}: {
  title?: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card">
      {title ? (
        <header className="card-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export type PillTone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';

export function Pill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

/**
 * Map a Genesys bot result category to a tone.
 *
 * `Containment` is the success case for a virtual agent: it handled the conversation without a
 * human. A transfer is not a failure - it is often the correct outcome - so it reads as
 * informational rather than as an error, and only genuine error categories are given the alarm
 * colour.
 */
export function outcomeTone(category: string | null): PillTone {
  if (!category) return 'neutral';
  const value = category.toLowerCase();
  if (value.includes('contain')) return 'good';
  if (value.includes('error') || value.includes('fail')) return 'bad';
  if (value.includes('disconnect') || value.includes('abandon')) return 'warn';
  if (value.includes('transfer') || value.includes('exit')) return 'info';
  return 'neutral';
}

export function retrievalTone(status: string | null): PillTone {
  switch (status) {
    case 'ARCHIVED':
      return 'good';
    case 'NO_HISTORY':
      return 'warn';
    case 'DOWNLOAD_FAILED':
      return 'bad';
    default:
      return 'neutral';
  }
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function ShortId({ id, href }: { id: string | null; href?: string }) {
  if (!id) return <span className="mono-id">&mdash;</span>;
  const short = `${id.slice(0, 8)}\u2026`;
  if (href) {
    return (
      <Link href={href} className="mono" title={id}>
        {short}
      </Link>
    );
  }
  return (
    <span className="mono-id" title={id}>
      {short}
    </span>
  );
}

export function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '—';
  return new Date(parsed).toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatMs(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value < 1000) return `${value} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}

export function formatPercent(value: number | null): string {
  if (value == null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}
