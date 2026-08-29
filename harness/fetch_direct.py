"""VALIDATION 5 and 6 - signed URI behaviour: TTL semantics, expiry, auth requirement.

Answers, for a captured notification:

  - Does the signed URI work with no Authorization header at all? (If it does, the download
    is outside the Platform API auth domain, which matters for validation 6.)
  - Does an Authorization header change the outcome?
  - What host actually serves it, after redirects?
  - Where does the TTL clock start - event generation, or URI generation?
  - What happens at and after expiry, and what is the precise failure shape?

Usage:
  python harness/fetch_direct.py --event artifacts/samples/<event>.json
  python harness/fetch_direct.py --event <event>.json --wait-for-expiry
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from datetime import datetime, timedelta, timezone

import gcapi


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--event", required=True, help="captured notification JSON")
    ap.add_argument("--ca-bundle")
    ap.add_argument(
        "--wait-for-expiry",
        action="store_true",
        help="sleep past executionHistoryUriTtl and re-fetch, to capture the expiry failure shape",
    )
    ap.add_argument(
        "--max-wait",
        type=int,
        default=1800,
        help="refuse to sleep longer than this many seconds (default 1800)",
    )
    args = ap.parse_args()

    event = gcapi.load_event(args.event)
    execution_id = gcapi.require_field(event, "executionId")
    uri = gcapi.require_field(event, "executionHistoryUri")
    ttl = event.get("executionHistoryUriTtl")

    gcapi.banner(f"VALIDATION 5/6 - signed URI behaviour for {execution_id}")

    print(f"  executionHistoryUriTtl : {ttl} (seconds, per the org's topic schema)")
    print(f"  host                   : {gcapi.redact_url(uri).split('/')[2]}")

    start = parse_iso(event.get("startDateTime"))
    end = parse_iso(event.get("endDateTime"))
    now = datetime.now(timezone.utc)
    if end:
        print(f"  flow endDateTime       : {end.isoformat()}  ({(now - end).total_seconds():.0f}s ago)")
    if isinstance(ttl, (int, float)) and end:
        print(f"  expiry if TTL runs from flow end : {(end + timedelta(seconds=ttl)).isoformat()}")

    evidence: dict = {
        "executionId": execution_id,
        "probedAt": now.isoformat(),
        "ttlSeconds": ttl,
        "startDateTime": event.get("startDateTime"),
        "endDateTime": event.get("endDateTime"),
        "flowId": event.get("flowId"),
        "flowType": event.get("flowType"),
        "executionItemsTruncated": event.get("executionItemsTruncated"),
        "attempts": [],
    }

    # -- 1. anonymous fetch. The important question, and the cheapest to answer.
    print("\n  [1] GET with no Authorization header")
    anon = gcapi.request(uri, ca_bundle=args.ca_bundle)
    print(f"      status {anon.status}  {len(anon.body)} bytes  {anon.elapsed_ms} ms")
    print(f"      served by: {anon.summary()['finalHost']}")
    evidence["attempts"].append({"mode": "anonymous", **anon.summary()})

    if anon.ok:
        digest = hashlib.sha256(anon.body).hexdigest()
        evidence["sha256"] = digest
        evidence["authRequired"] = False
        print(f"      sha256: {digest}")
        print("      => the signature alone authorises the download; no OAuth token needed.")
        blob = gcapi.write_blob(f"{execution_id}-direct.json", anon.body)
        print(f"      body saved to {blob}")

        try:
            parsed = json.loads(anon.body)
            top = sorted(parsed.keys()) if isinstance(parsed, dict) else f"<{type(parsed).__name__}>"
            print(f"      top-level keys: {top}")
            evidence["topLevelKeys"] = top if isinstance(top, list) else None
        except json.JSONDecodeError:
            print("      body is not JSON - recording as opaque bytes")
            evidence["topLevelKeys"] = None
    else:
        evidence["authRequired"] = True
        print(f"      error: {anon.error}")

        # -- 2. only worth trying if anonymous failed
        print("\n  [2] GET with Authorization header")
        client = gcapi.Client(gcapi.load_org_config(), ca_bundle=args.ca_bundle)
        authed = gcapi.request(
            uri,
            headers={"Authorization": f"Bearer {client.token()}"},
            ca_bundle=args.ca_bundle,
        )
        print(f"      status {authed.status}  {len(authed.body)} bytes  {authed.elapsed_ms} ms")
        evidence["attempts"].append({"mode": "bearer", **authed.summary()})
        if authed.ok:
            evidence["sha256"] = hashlib.sha256(authed.body).hexdigest()
            gcapi.write_blob(f"{execution_id}-direct.json", authed.body)
            print("      => download requires an OAuth token in addition to the signature.")

    # -- 3. redirect behaviour, which validation 5 asks about explicitly
    print("\n  [3] GET without following redirects")
    noredir = gcapi.request(uri, ca_bundle=args.ca_bundle, follow_redirects=False)
    location = {k.lower(): v for k, v in noredir.headers.items()}.get("location")
    print(f"      status {noredir.status}" + (f"  -> redirects to {gcapi.redact_url(location).split('/')[2]}" if location else "  (no redirect)"))
    evidence["attempts"].append({"mode": "no-redirect", "redirected": bool(location), **noredir.summary()})

    # -- 4. expiry
    if args.wait_for_expiry and isinstance(ttl, (int, float)):
        wait = int(ttl) + 30
        if wait > args.max_wait:
            print(f"\n  [4] SKIPPED: TTL is {ttl}s, which exceeds --max-wait {args.max_wait}s.")
            print("      Re-run later with a larger --max-wait, or re-run this script after expiry.")
        else:
            print(f"\n  [4] sleeping {wait}s to pass the TTL, then re-fetching")
            time.sleep(wait)
            expired = gcapi.request(uri, ca_bundle=args.ca_bundle)
            print(f"      status {expired.status}  {expired.elapsed_ms} ms")
            snippet = expired.body[:400].decode("utf-8", errors="replace")
            print(f"      body: {snippet}")
            evidence["attempts"].append(
                {"mode": "post-expiry", "waitedSeconds": wait, "bodySnippet": snippet, **expired.summary()}
            )
            evidence["expiryConfirmed"] = not expired.ok
            if expired.ok:
                print("      => URI still valid past its stated TTL. TTL is not a hard deadline.")
            else:
                print("      => URI is dead after TTL, as documented. Download must happen inline.")

    out = gcapi.write_artifact(f"v5-signed-uri-{execution_id}.json", evidence)
    print(f"\n  Evidence: {out}")
    return 0 if evidence.get("sha256") else 1


if __name__ == "__main__":
    raise SystemExit(main())
