export default function AppLoading() {
  return (
    <div aria-label="Loading page" aria-live="polite">
      <span className="page-eyebrow">Loading</span>
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-line" />
      <div className="grid grid-kpi loading-grid">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="skeleton skeleton-card" key={index} />
        ))}
      </div>
      <div className="skeleton loading-panel" />
      <span className="visually-hidden">Loading AVA observability data</span>
    </div>
  );
}
