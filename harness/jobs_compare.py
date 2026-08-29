"""VALIDATIONS 1, 2 and 3 - the Jobs API as fallback and as the fidelity benchmark.

  V3: is the notification's `executionId` accepted verbatim in POST /flows/instances/jobs ids[]?
      This is the precondition for a zero-query fallback path. Naming similarity is not proof.

  V2: do the Jobs `expand` options yield anything the direct signed download lacks?
      The script discovers the supported expand values from the live OpenAPI spec rather than
      hard-coding a guess, then runs one job per variant.

  V1: does the direct download carry the same AVA detail as the richest Jobs artifact?
      This script gathers the artifacts; semantic_diff.py renders the comparison.

Artifacts land in artifacts/validation/ named by execution and variant, so semantic_diff.py
can pick them up without being told where they are.

Usage:
  python harness/jobs_compare.py --event artifacts/samples/<event>.json
  python harness/jobs_compare.py --execution-id <id>          # skip the event, test Jobs only
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
import urllib.parse

import gcapi

JOBS_PATH = "/api/v2/flows/instances/jobs"


def discover_expands(client: gcapi.Client) -> list[str]:
    """Read the live Swagger definition for the Jobs POST body's supported expand values.

    Hard-coding these would be exactly the mistake the architecture warns about: the contract
    evolves, and a stale list would silently under-test validation 2. That risk is not
    hypothetical - the values are 'bots' and 'dataActions', where the obvious guesses from the
    prose ('bot', 'dataAction') would both have been rejected.
    """
    # The definition is public and roughly 22 MB, so it is fetched anonymously: there is no
    # reason to put a bearer token on a public document, and it avoids the request being
    # rejected for reasons unrelated to the contract we are reading.
    url = f"https://{client.config.api_host}/api/v2/docs/swagger"
    print(f"  Reading the live OpenAPI definition ({url})...")
    resp = gcapi.request(url, timeout=300, ca_bundle=client.ca_bundle)
    if not resp.ok:
        snippet = resp.body[:300].decode("utf-8", errors="replace")
        print(f"    could not read swagger: {resp.status} {resp.error} {snippet}")
        print("    falling back to the values observed in the spec on 2026-08-27")
        return ["bots", "dataActions"]

    print(f"    {len(resp.body) / 1_048_576:.1f} MB retrieved; parsing")
    try:
        spec = resp.json()
    except json.JSONDecodeError as exc:
        print(f"    swagger was not parseable ({exc}); falling back to documented guesses")
        return ["bots", "dataActions"]

    found: set[str] = set()

    # The expand vocabulary may appear as a query parameter enum on the Jobs paths, or as an
    # enum on the request-body definition. Check both rather than assuming a shape.
    for path, methods in (spec.get("paths") or {}).items():
        if "flows/instances/jobs" not in path:
            continue
        for method, op in (methods or {}).items():
            for param in op.get("parameters") or []:
                if param.get("name") in ("expand", "expands") and param.get("enum"):
                    found.update(param["enum"])
                ref = (param.get("schema") or {}).get("$ref")
                if ref:
                    name = ref.split("/")[-1]
                    definition = (spec.get("definitions") or {}).get(name) or {}
                    expand_prop = (definition.get("properties") or {}).get("expands") or {}
                    items = expand_prop.get("items") or {}
                    if items.get("enum"):
                        found.update(items["enum"])

    for name, definition in (spec.get("definitions") or {}).items():
        if not re.search(r"FlowExecution|FlowInstance", name, re.I):
            continue
        prop = (definition.get("properties") or {}).get("expands") or {}
        items = prop.get("items") or {}
        if items.get("enum"):
            found.update(items["enum"])

    if found:
        print(f"    discovered: {sorted(found)}")
        return sorted(found)
    print("    no expand enum found in the spec; falling back to documented guesses")
    return ["bots", "dataActions"]


def submit_job(client: gcapi.Client, execution_id: str, expands: list[str] | None) -> dict:
    # expand is a QUERY parameter on POST /flows/instances/jobs, not a body field. The body is
    # an ExecutionDataRequest carrying only `ids`. Putting expands in the body is silently
    # ignored rather than rejected, which would have made validation 2 look like a pass while
    # testing nothing.
    payload: dict = {"ids": [execution_id]}
    path = JOBS_PATH
    if expands:
        path = f"{JOBS_PATH}?expand={urllib.parse.quote(','.join(expands))}"

    label = ",".join(expands) if expands else "default"
    print(f"\n  -- Job variant: {label}")
    resp = client.api(path, method="POST", payload=payload)

    result: dict = {"variant": label, "expands": expands or [], "submit": resp.summary()}

    if not resp.ok:
        body = resp.body[:400].decode("utf-8", errors="replace")
        print(f"     submit failed: {resp.status} {body}")
        result["error"] = body
        # A 400 naming the expand value means the vocabulary is wrong, not the id.
        result["idAccepted"] = resp.status not in (400, 404)
        return result

    job = resp.json()
    job_id = job.get("id")
    print(f"     job {job_id} accepted, state {job.get('jobState')}")
    result["jobId"] = job_id
    result["idAccepted"] = True
    return result


# GetFlowExecutionDataJobResult.jobState, straight from the spec. Guessed names like
# "Complete" or "Cancelled" do not exist, and polling for them means never recognising
# completion and burning the full timeout on every variant.
TERMINAL_STATES = {"Success", "Failed"}


def poll_job(client: gcapi.Client, job_id: str, timeout_s: int = 300) -> dict:
    """Poll conservatively, as the architecture's section 8.4 requires."""
    deadline = time.time() + timeout_s
    delay = 3.0
    last: dict = {}
    while time.time() < deadline:
        resp = client.api(f"{JOBS_PATH}/{job_id}")
        if not resp.ok:
            return {"error": f"poll failed {resp.status}", "raw": resp.body[:300].decode(errors="replace")}
        last = resp.json()
        state = last.get("jobState")
        print(f"     state {state}")
        if state in TERMINAL_STATES:
            return last
        time.sleep(delay)
        delay = min(delay * 1.5, 20.0)  # backoff with a ceiling
    return {**last, "error": f"did not reach a terminal state within {timeout_s}s"}


def fetch_results(job: dict, ca_bundle: str | None) -> list[dict]:
    """Extract the per-execution download links from a finished job.

    Shape, per GetFlowExecutionDataJobResult:
        entities[] of ExecutionDataEntity { id, downloadUri, failed, statusCode }
    """
    links: list[dict] = []
    for entity in job.get("entities") or []:
        uri = entity.get("downloadUri")
        record = {
            "executionId": entity.get("id"),
            "failed": entity.get("failed"),
            "statusCode": entity.get("statusCode"),
            "url": uri,
        }
        if not uri:
            print(
                f"       no downloadUri for {entity.get('id')} "
                f"(failed={entity.get('failed')}, statusCode={entity.get('statusCode')})"
            )
            continue
        links.append(record)
    return links


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--event", help="captured notification JSON")
    ap.add_argument("--execution-id", help="use instead of --event to test Jobs alone")
    ap.add_argument("--ca-bundle")
    ap.add_argument("--skip-expands", action="store_true", help="run only the default variant")
    ap.add_argument("--poll-timeout", type=int, default=300)
    ap.add_argument(
        "--discover-only",
        action="store_true",
        help="resolve the supported expand vocabulary and exit; submits no job",
    )
    args = ap.parse_args()

    # The expand vocabulary is a property of the org's API contract, not of any execution, so
    # it is answerable before a single event has been captured.
    if args.discover_only:
        client = gcapi.Client(gcapi.load_org_config(), ca_bundle=args.ca_bundle)
        gcapi.banner("VALIDATION 2 (part 1) - supported Jobs expand vocabulary")
        expands = discover_expands(client)
        print(f"\n  Supported expand values: {expands or '(none found)'}")
        print("  Each becomes one job variant when a real executionId is available.")
        gcapi.write_artifact("v2-expand-vocabulary.json", {"discoveredExpands": expands})
        return 0

    if args.event:
        event = gcapi.load_event(args.event)
        execution_id = gcapi.require_field(event, "executionId")
    elif args.execution_id:
        execution_id = args.execution_id
    else:
        raise SystemExit("pass --event or --execution-id")

    client = gcapi.Client(gcapi.load_org_config(), ca_bundle=args.ca_bundle)

    gcapi.banner(f"VALIDATIONS 1/2/3 - Jobs API for {execution_id}")

    expand_values = [] if args.skip_expands else discover_expands(client)

    variants: list[list[str] | None] = [None]
    variants += [[e] for e in expand_values]
    if len(expand_values) > 1:
        variants.append(expand_values)  # everything at once, the richest artifact

    evidence: dict = {
        "executionId": execution_id,
        "discoveredExpands": expand_values,
        "variants": [],
    }

    for expands in variants:
        result = submit_job(client, execution_id, expands)
        if result.get("jobId"):
            job = poll_job(client, result["jobId"], args.poll_timeout)
            result["finalState"] = job.get("jobState")
            result["jobResponse"] = job

            if job.get("jobState") == "Failed":
                print(f"     job reported Failed: {json.dumps(job)[:300]}")

            links = fetch_results(job, args.ca_bundle)
            result["downloadLinks"] = [{**d, "url": gcapi.redact_url(d["url"])} for d in links]
            print(f"     {len(links)} download link(s) found")

            for i, link in enumerate(links):
                resp = gcapi.request(link["url"], ca_bundle=args.ca_bundle)
                if resp.ok:
                    digest = hashlib.sha256(resp.body).hexdigest()
                    suffix = result["variant"].replace(",", "-")
                    name = f"{execution_id}-job-{suffix}-{i}.json"
                    gcapi.write_blob(name, resp.body)
                    link_ev = {"sha256": digest, "bytes": len(resp.body), "savedAs": name}
                    print(f"       [{i}] {len(resp.body)} bytes, sha256 {digest[:16]}... -> {name}")
                else:
                    link_ev = {"error": resp.error, "status": resp.status}
                    print(f"       [{i}] download failed: {resp.status}")
                result.setdefault("downloads", []).append(link_ev)

        evidence["variants"].append(result)

    # ------------------------------------------------------------------- verdict
    print("\n  === Verdict ===")
    default_variant = evidence["variants"][0]
    v3_pass = bool(default_variant.get("idAccepted"))
    print(f"  V3 - notification executionId accepted by Jobs ids[]: {'PASS' if v3_pass else 'FAIL'}")
    if not v3_pass:
        print("       The fallback path needs an id translation step; it is not zero-query.")

    hashes = {}
    for v in evidence["variants"]:
        for d in v.get("downloads", []) or []:
            if d.get("sha256"):
                hashes.setdefault(d["sha256"], []).append(v["variant"])
    if len(hashes) == 1 and len(evidence["variants"]) > 1:
        print("  V2 - every expand variant produced identical bytes.")
        print("       Expansions add nothing for this execution, so the direct URI loses nothing.")
    elif len(hashes) > 1:
        print(f"  V2 - variants differ ({len(hashes)} distinct artifacts). Expansions DO add data:")
        for digest, names in hashes.items():
            print(f"       {digest[:16]}...  {names}")
        print("       Run semantic_diff.py to see which fields the direct download lacks.")
    else:
        print("  V2 - no artifacts downloaded; cannot conclude.")

    evidence["v3IdAccepted"] = v3_pass
    evidence["distinctArtifactHashes"] = {k: v for k, v in hashes.items()}

    out = gcapi.write_artifact(f"v1-v2-v3-jobs-{execution_id}.json", evidence)
    print(f"\n  Evidence: {out}")
    print("  Next: python harness/semantic_diff.py --execution-id " + execution_id)
    return 0 if v3_pass else 1


if __name__ == "__main__":
    raise SystemExit(main())
