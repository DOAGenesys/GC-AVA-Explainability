export interface TechnicalAsset {
  name: string;
  role: string;
  reference?: string;
}

/**
 * Compact, page-specific lineage for the Notifications → Jobs capture path.
 *
 * Keeping this presentational and server-rendered avoids adding client JavaScript to analytical
 * pages while giving every metric a visible provenance.
 */
export function TechnicalAssets({
  summary,
  assets,
}: {
  summary: string;
  assets: readonly TechnicalAsset[];
}) {
  return (
    <aside className="technical-assets" aria-label="Technical assets used by this section">
      <header>
        <span>Under the hood</span>
        <p>{summary}</p>
      </header>
      <div className="technical-asset-list">
        {assets.map((asset, index) => (
          <div className="technical-asset" key={`${asset.name}-${asset.reference ?? index}`}>
            <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
            <dl>
              <dt>{asset.name}</dt>
              <dd>{asset.role}</dd>
              {asset.reference ? (
                <dd className="technical-reference">
                  <code>{asset.reference}</code>
                </dd>
              ) : null}
            </dl>
          </div>
        ))}
      </div>
    </aside>
  );
}
