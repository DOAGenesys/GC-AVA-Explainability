import Link from 'next/link';

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
  backHref,
  backLabel,
}: {
  eyebrow: string;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <header className="page-head">
      <div className="page-head-copy">
        {backHref ? (
          <Link className="back-link" href={backHref}>
            <span aria-hidden="true">←</span>
            {backLabel ?? 'Back'}
          </Link>
        ) : null}
        <span className="page-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {description ? <div className="page-description">{description}</div> : null}
      </div>
      {action ? <div className="page-actions">{action}</div> : null}
    </header>
  );
}
