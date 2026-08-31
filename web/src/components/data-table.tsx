export function DataTable({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="table-frame" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
