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
 * whatever is stored, and React reconciles the difference after hydration without a setState cascade
 * or a markup mismatch.
 *
 * Submission stays a native form GET, so sign-in still works with JavaScript disabled and the
 * remembering is purely an enhancement on top.
 */

const STORE_KEY = 'ava.signin';
const MAX_REMEMBERED = 5;
const DEFAULT_REGION = 'mypurecloud.de';

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

export function LoginForm({ next }: { next?: string }) {
  const raw = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const remembered = useMemo(() => parse(raw), [raw]);

  // Only what the user has actually typed; the remembered values supply the rest.
  const [editedRegion, setEditedRegion] = useState<string | null>(null);
  const [editedClientId, setEditedClientId] = useState<string | null>(null);

  const region = editedRegion ?? remembered.region ?? DEFAULT_REGION;
  const clientId = editedClientId ?? remembered.clientIds[0] ?? '';
  const suggested = editedClientId === null && remembered.clientIds.length > 0;

  return (
    <form method="GET" action="/api/auth/login" onSubmit={() => remember(region, clientId)}>
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <div className="field">
        <label htmlFor="region">Genesys region</label>
        <input
          id="region"
          name="region"
          required
          placeholder={DEFAULT_REGION}
          autoComplete="off"
          spellCheck={false}
          value={region}
          onChange={(e) => setEditedRegion(e.target.value)}
        />
        <p className="field-hint">
          The region domain, for example mypurecloud.de or mypurecloud.com.
        </p>
      </div>

      <div className="field">
        <label htmlFor="clientId">OAuth Client ID</label>
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
            : "A Code Authorization client whose redirect URI is this app's /api/auth/callback."}
        </p>
      </div>

      <button className="btn-primary" type="submit">
        Continue to Genesys
      </button>
    </form>
  );
}
