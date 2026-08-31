'use client';

import { useMemo, useState, useSyncExternalStore } from 'react';

/**
 * Sign-in form, remembering the region and OAuth client ids this browser has used before.
 *
 * Both values are safe to persist: the client id of a PKCE public client is not a secret (it is
 * visible in the authorize URL by design) and the region is a public hostname. Access and refresh
 * tokens stay in an encrypted HttpOnly cookie that this code cannot read.
 *
 * localStorage is read through `useSyncExternalStore` rather than an effect. It is an external
 * store, so this is what the hook exists for: the server snapshot is empty, the client snapshot is
 * whatever is stored, and React reconciles the difference after hydration without a setState
 * cascade or a markup mismatch.
 *
 * Submission stays a native form GET, so sign-in still works with JavaScript disabled and the
 * remembering is purely an enhancement on top.
 */

const STORE_KEY = 'ava.signin';
const MAX_REMEMBERED = 5;
const FALLBACK_REGION = 'mypurecloud.de';

interface Remembered {
  region: string | null;
  clientIds: string[];
}

const EMPTY: Remembered = { region: null, clientIds: [] };

function subscribe(onStoreChange: () => void): () => void {
  // Keeps a second tab in step; the form is otherwise indifferent to changes.
  window.addEventListener('storage', onStoreChange);
  return () => window.removeEventListener('storage', onStoreChange);
}

/** Returns the raw string so the snapshot is a stable primitive across reads. */
function getSnapshot(): string | null {
  try {
    return window.localStorage.getItem(STORE_KEY);
  } catch {
    // Private browsing can throw on access. Sign-in must still work.
    return null;
  }
}

function getServerSnapshot(): string | null {
  return null;
}

function parse(raw: string | null): Remembered {
  if (!raw) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY;
    const { region, clientIds } = parsed as Partial<Remembered>;
    return {
      region: typeof region === 'string' && region.length > 0 ? region : null,
      clientIds: Array.isArray(clientIds)
        ? clientIds.filter((v): v is string => typeof v === 'string').slice(0, MAX_REMEMBERED)
        : [],
    };
  } catch {
    return EMPTY;
  }
}

function remember(region: string, clientId: string): void {
  try {
    const current = parse(getSnapshot());
    const clientIds = [clientId, ...current.clientIds.filter((id) => id !== clientId)]
      .filter((id) => id.length > 0)
      .slice(0, MAX_REMEMBERED);
    window.localStorage.setItem(STORE_KEY, JSON.stringify({ region, clientIds }));
  } catch {
    // Persisting is best-effort and must never block a sign-in.
  }
}

function CopyIcon({ done }: { done: boolean }) {
  return done ? (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 6 9 17l-5-5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
      <path
        d="M5 15V5a2 2 0 0 1 2-2h8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The redirect URI the Genesys OAuth client must authorise, one click away from the clipboard. */
function CallbackUrlCopy({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard needs a secure context and permission; the URL is selectable regardless.
    }
  };

  return (
    <button type="button" className="tip-copy" onClick={copy} aria-label="Copy the redirect URI">
      <span className="tip-copy-url">{url}</span>
      <CopyIcon done={copied} />
    </button>
  );
}

function ClientIdHelp({ callbackUrl }: { callbackUrl: string }) {
  return (
    <span className="tip">
      <button type="button" className="tip-trigger" aria-label="Client ID help">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M9.6 9.3a2.5 2.5 0 1 1 3.4 2.33c-.62.25-1 .85-1 1.52v.35"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <circle cx="12" cy="16.8" r="1.05" fill="currentColor" />
        </svg>
      </button>
      <span className="tip-pop" role="tooltip">
        <span>
          Create an OAuth client in your Genesys Cloud org with the{' '}
          <strong>Code Authorization</strong> grant type, then add the redirect URI below to its{' '}
          <strong>Authorized redirect URIs</strong>. Only the Client ID is needed — PKCE means there
          is no client secret to store.
        </span>
        {callbackUrl ? <CallbackUrlCopy url={callbackUrl} /> : null}
      </span>
    </span>
  );
}

export function LoginForm({
  next,
  defaultRegion,
  callbackUrl,
}: {
  next?: string;
  /** Seeded from GENESYS_REGION on the server; the user can always override it. */
  defaultRegion?: string;
  callbackUrl: string;
}) {
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const remembered = useMemo(() => parse(raw), [raw]);

  // Only what the user has actually typed; remembered and configured values supply the rest.
  const [editedRegion, setEditedRegion] = useState<string | null>(null);
  const [editedClientId, setEditedClientId] = useState<string | null>(null);

  // Precedence: what you typed, then what you used last here, then the deployment default.
  const region = editedRegion ?? remembered.region ?? (defaultRegion || null) ?? FALLBACK_REGION;
  const clientId = editedClientId ?? remembered.clientIds[0] ?? '';
  const suggested = editedClientId === null && remembered.clientIds.length > 0;

  return (
    <form method="GET" action="/api/auth/login" onSubmit={() => remember(region, clientId)}>
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <div className="field">
        <label htmlFor="region">Genesys Cloud region</label>
        <input
          id="region"
          name="region"
          required
          placeholder={FALLBACK_REGION}
          autoComplete="off"
          spellCheck={false}
          value={region}
          onChange={(e) => setEditedRegion(e.target.value)}
        />
        <p className="field-hint">
          {defaultRegion && region === defaultRegion && editedRegion === null
            ? `Default for this deployment. Override it to sign in to a different region.`
            : 'The region domain, for example mypurecloud.de or usw2.pure.cloud.'}
        </p>
      </div>

      <div className="field">
        <label htmlFor="clientId" className="label-row">
          OAuth Client ID
          <ClientIdHelp callbackUrl={callbackUrl} />
        </label>
        <input
          id="clientId"
          name="clientId"
          required
          placeholder="00000000-0000-0000-0000-000000000000"
          autoComplete="off"
          spellCheck={false}
          list={remembered.clientIds.length > 1 ? 'known-client-ids' : undefined}
          value={clientId}
          onChange={(e) => setEditedClientId(e.target.value)}
        />
        {remembered.clientIds.length > 1 ? (
          <datalist id="known-client-ids">
            {remembered.clientIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        ) : null}
        <p className="field-hint">
          {suggested
            ? remembered.clientIds.length > 1
              ? 'Reusing your last Client ID on this browser. Others you have used are suggested as you type.'
              : 'Reusing the Client ID from your last sign-in on this browser.'
            : 'A Code Authorization client. Use the help above for the redirect URI it needs.'}
        </p>
      </div>

      <button className="btn-primary" type="submit">
        Continue to Genesys
      </button>
    </form>
  );
}
