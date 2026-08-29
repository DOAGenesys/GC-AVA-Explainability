"""VALIDATION 4 - the exact semantics of the notification's `endpoint` field.

The topic schema calls `endpoint` "a public endpoint a user can use to retrieve the full
historical log". If that is a durable, re-fetchable address then it is a cheaper recovery
path than the Jobs API, and the architecture's fallback branch gets much simpler. If it is
just the signed URI's origin, it is worthless for recovery.

Determines:
  - the URL shape, and how it relates to executionHistoryUri
  - whether it requires OAuth, a signature, or nothing
  - whether it redirects to a freshly-signed URI (the valuable outcome)
  - whether it still works after executionHistoryUri has expired
  - whether it returns the same bytes as the direct download

Usage:
  python harness/probe_endpoint.py --event artifacts/samples/<event>.json
"""

from __future__ import annotations

import argparse
import hashlib
import time
import urllib.parse

import gcapi


def poll_job(client: gcapi.Client, job_id: str, timeout_s: int = 180) -> dict:
    """Poll an execution-data job to a terminal state and return its reference.

    Terminal states are 'Success' and 'Failed'. Waiting for invented names like 'Complete'
    burns the whole timeout without ever matching, which is why the enum is pinned here.
    """
    deadline = time.time() + timeout_s
    last: dict = {}
    while time.time() < deadline:
        resp = client.api(f"/api/v2/flows/instances/jobs/{job_id}")
        if not resp.ok:
            return {"jobId": job_id, "error": f"{resp.status} {resp.error}"}
        last = resp.json()
        state = last.get("jobState")
        if state in ("Success", "Failed"):
            entities = last.get("entities") or []
            download = entities[0].get("downloadUri") if entities else None
            return {
                "jobId": job_id,
                "jobState": state,
                "entityCount": len(entities),
                "downloadUri": download,
                "downloadUriRedacted": gcapi.redact_url(download) if download else None,
            }
        time.sleep(3)
    return {"jobId": job_id, "jobState": last.get("jobState"), "error": "timed out"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--event", required=True)
    ap.add_argument("--ca-bundle")
    args = ap.parse_args()

    event = gcapi.load_event(args.event)
    execution_id = gcapi.require_field(event, "executionId")
    endpoint = event.get("endpoint")
    direct_uri = event.get("executionHistoryUri")

    gcapi.banner(f"VALIDATION 4 - endpoint semantics for {execution_id}")

    if not endpoint:
        print("  The captured event has no 'endpoint' value.")
        print("  The field is in the schema but was not populated for this execution.")
        gcapi.write_artifact(
            f"v4-endpoint-{execution_id}.json",
            {"executionId": execution_id, "endpointPresent": False},
        )
        return 1

    config = gcapi.load_org_config()

    # Observed on real events: `endpoint` is a *relative* API path, e.g.
    # "api/v2/flows/instances/<executionId>" - no scheme and no host. So it is a platform API
    # route to be resolved against the org's API host, not a pre-signed object URL. Resolving it
    # here rather than upstream keeps the raw value in the evidence artifact.
    parsed = urllib.parse.urlparse(endpoint)
    is_relative = not parsed.scheme
    resolved = f"https://{config.api_host}/{endpoint.lstrip('/')}" if is_relative else endpoint

    print(f"  endpoint : {gcapi.redact_url(endpoint) if not is_relative else endpoint}")
    print(f"  form     : {'relative API path' if is_relative else 'absolute URL'}")
    print(f"  resolved : {resolved}")
    print(f"  query    : {'present' if parsed.query else 'none'}")

    evidence: dict = {
        "executionId": execution_id,
        "endpoint": endpoint,
        "isRelativePath": is_relative,
        "resolved": resolved,
        "host": urllib.parse.urlparse(resolved).hostname,
        "path": urllib.parse.urlparse(resolved).path,
        "hasQuery": bool(parsed.query),
        "signedUriPresentOnEvent": bool(direct_uri),
        "attempts": [],
    }
    endpoint = resolved

    if direct_uri:
        direct_host = urllib.parse.urlparse(direct_uri).hostname
        same = direct_host == urllib.parse.urlparse(endpoint).hostname
        evidence["sameHostAsSignedUri"] = same
        print(f"  same host as executionHistoryUri: {same}")
    else:
        print("  note: this event carries NO executionHistoryUri, so endpoint is the only")
        print("        retrieval address on the notification itself.")

    # 1. anonymous
    print("\n  [1] GET anonymous")
    anon = gcapi.request(endpoint, ca_bundle=args.ca_bundle)
    print(f"      status {anon.status}  {len(anon.body)} bytes  -> {anon.summary()['finalHost']}")
    evidence["attempts"].append({"mode": "anonymous", **anon.summary()})

    # 2. with a platform token
    print("\n  [2] GET with Authorization: Bearer")
    client = gcapi.Client(config, ca_bundle=args.ca_bundle)
    authed = gcapi.request(
        endpoint,
        headers={"Authorization": f"Bearer {client.token()}"},
        ca_bundle=args.ca_bundle,
    )
    print(f"      status {authed.status}  {len(authed.body)} bytes  -> {authed.summary()['finalHost']}")
    evidence["attempts"].append({"mode": "bearer", **authed.summary()})

    # 3. does it hand back a fresh signed URI? That is the outcome worth having.
    print("\n  [3] GET with Authorization, redirects NOT followed")
    noredir = gcapi.request(
        endpoint,
        headers={"Authorization": f"Bearer {client.token()}"},
        ca_bundle=args.ca_bundle,
        follow_redirects=False,
    )
    headers = {k.lower(): v for k, v in noredir.headers.items()}
    location = headers.get("location")
    print(f"      status {noredir.status}")
    refreshes = False
    if location:
        loc_parsed = urllib.parse.urlparse(location)
        signed = any(
            k.lower().startswith("x-amz-") or k.lower() in ("signature", "sig", "token")
            for k, _ in urllib.parse.parse_qsl(loc_parsed.query)
        )
        refreshes = signed
        print(f"      redirects to {loc_parsed.hostname}, signed query: {signed}")
    else:
        print("      no Location header")
    evidence["attempts"].append({"mode": "bearer-no-redirect", "redirected": bool(location), **noredir.summary()})
    evidence["refreshesSignedUri"] = refreshes

    # 4. A 200 from `endpoint` is not necessarily content. Observed behaviour: it returns
    #    {"id", "jobState", "selfUri"} - i.e. GETting the endpoint *creates an execution-data
    #    job* and hands back its reference. That makes endpoint a per-execution convenience
    #    wrapper over the Jobs API rather than a content address, which changes which retrieval
    #    strategy the collector should use, so it is followed through to the bytes here.
    job_evidence = None
    if authed.ok:
        try:
            payload = authed.json()
        except Exception:
            payload = None
        if isinstance(payload, dict) and "jobState" in payload:
            job_id = payload["id"]
            print(f"\n  [4] endpoint created job {job_id} (state {payload['jobState']}); polling")
            job_evidence = poll_job(client, job_id)
            evidence["endpointCreatesJob"] = True
            evidence["job"] = job_evidence
            if job_evidence.get("downloadUri"):
                blob = gcapi.request(job_evidence["downloadUri"], ca_bundle=args.ca_bundle)
                if blob.ok:
                    digest = hashlib.sha256(blob.body).hexdigest()
                    job_evidence["artifactBytes"] = len(blob.body)
                    job_evidence["artifactSha256"] = digest
                    gcapi.write_blob(f"{execution_id}-endpoint-job.json", blob.body)
                    print(f"      artifact: {len(blob.body)} bytes, sha256 {digest[:16]}...")
                else:
                    print(f"      artifact download failed: {blob.status} {blob.error}")
        else:
            evidence["endpointCreatesJob"] = False

    # ------------------------------------------------------------------- verdict
    best = authed if authed.ok else anon
    print("\n  === Verdict ===")
    if best.ok:
        digest = hashlib.sha256(best.body).hexdigest()
        evidence["sha256"] = digest
        evidence["authRequired"] = not anon.ok
        gcapi.write_blob(f"{execution_id}-endpoint.json", best.body)
        print(f"  Authentication required: {not anon.ok}")
        if job_evidence:
            print("  endpoint is a per-execution wrapper over the Jobs API: a GET creates an")
            print("  execution-data job and returns its reference, which must then be polled.")
            print(f"  job {job_evidence.get('jobState')}, {job_evidence.get('entityCount')} entity")
            if job_evidence.get("artifactBytes"):
                print(
                    f"  artifact {job_evidence['artifactBytes']} bytes, "
                    f"sha256 {job_evidence['artifactSha256'][:16]}..."
                )
            print("  So it is durable and re-fetchable with no TTL, but it is NOT a cheaper")
            print("  path than Jobs - and it cannot batch, so bulk Jobs is strictly better.")
        elif refreshes:
            print("  It issues a fresh signed URI, so it is a viable recovery path that")
            print("  avoids the Jobs API entirely. Prefer it in the fallback branch.")
        else:
            print(f"  It serves content directly ({len(best.body)} bytes, sha256 {digest[:16]}...).")
    else:
        print(f"  Endpoint is not usable as a retrieval path: anon {anon.status}, bearer {authed.status}.")
        print("  Recovery must go through the Jobs API.")

    out = gcapi.write_artifact(f"v4-endpoint-{execution_id}.json", evidence)
    print(f"\n  Evidence: {out}")
    return 0 if best.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
