"""How many API calls does one execution's history actually cost, and can batching reduce it?

This is the question that decides whether the architecture scales, and it was left open in the
validation log as "exact Jobs batch limit, and content retrieval for batched jobs". Since no
notification ever carries a signed URI, every byte of execution history is fetched through
/api/v2/flows/instances/jobs, so the per-execution call count is the whole cost model.

Three measurements, in increasing order of consequence:

1. Batch acceptance ceiling. A job containing ids the platform holds nothing for is still accepted
   and still reaches Success, returning a per-id 404 entity. So the ceiling can be probed with
   synthetic uuids without touching real data - the limit is a property of the request, not of the
   executions in it.
2. Whether a batched job yields content. Only single-id jobs have been observed returning a
   downloadUri. If a batched job can be made to return them - by `expand`, or on a later poll -
   then one job serves N executions instead of one, and the retrieval cost drops by that factor.
3. Rate-limit budget. The inin-ratelimit-* response headers give the remaining allowance, which
   turns the per-execution call count into a sustainable executions-per-minute figure.

Reproduce:
    python harness/probe_jobs_cost.py --execution-id <id> [--execution-id <id> ...]
"""

from __future__ import annotations

import argparse
import json
import time
import uuid

import gcapi

TERMINAL = ("Success", "Failed")
RATE_HEADERS = ("inin-ratelimit-allowed", "inin-ratelimit-count", "inin-ratelimit-reset")


class CallCounter:
    def __init__(self) -> None:
        self.calls = 0
        self.last_rate: dict[str, str] = {}

    def api(self, client: gcapi.Client, path: str, **kwargs) -> gcapi.Response:
        self.calls += 1
        resp = client.api(path, **kwargs)
        lower = {k.lower(): v for k, v in resp.headers.items()}
        found = {h: lower[h] for h in RATE_HEADERS if h in lower}
        if found:
            self.last_rate = found
        return resp


def run_job(counter, client, ids, expand=None, label=""):
    """Submit one job, poll to terminal, and report the calls it took and what came back."""
    path = "/api/v2/flows/instances/jobs" + (f"?expand={expand}" if expand else "")
    before = counter.calls
    resp = counter.api(client, path, method="POST", payload={"ids": ids})
    if not resp.ok:
        return {
            "label": label,
            "size": len(ids),
            "accepted": False,
            "status": resp.status,
            "calls": counter.calls - before,
        }
    job_id = resp.json()["id"]
    entities, state, polls = [], None, 0
    deadline = time.time() + 180
    while time.time() < deadline:
        poll = counter.api(client, f"/api/v2/flows/instances/jobs/{job_id}")
        polls += 1
        if not poll.ok:
            break
        payload = poll.json()
        state = payload.get("jobState")
        if state in TERMINAL:
            entities = payload.get("entities") or []
            break
        time.sleep(3)
    with_uri = [e for e in entities if e.get("downloadUri")]
    return {
        "label": label,
        "size": len(ids),
        "accepted": True,
        "expand": expand,
        "jobState": state,
        "polls": polls,
        "calls": counter.calls - before,
        "entities": len(entities),
        "entitiesWithDownloadUri": len(with_uri),
        "entityKeys": sorted(entities[0].keys()) if entities else [],
        "sampleEntity": entities[0] if entities else None,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--execution-id", action="append", required=True)
    ap.add_argument("--skip-ceiling", action="store_true")
    args = ap.parse_args()

    client = gcapi.Client(gcapi.load_org_config())
    counter = CallCounter()
    real = list(args.execution_id)
    report: dict = {"realIds": real, "batchCeiling": [], "contentTests": []}

    gcapi.banner("Jobs cost model")

    # ---------------------------------------------------------------- 1. batch ceiling
    if not args.skip_ceiling:
        print("  === batch acceptance ceiling (synthetic ids) ===")
        for size in (8, 12, 16, 20, 25, 50):
            ids = [str(uuid.uuid4()) for _ in range(size)]
            resp = counter.api(
                client, "/api/v2/flows/instances/jobs", method="POST", payload={"ids": ids}
            )
            verdict = "accepted" if resp.ok else f"REJECTED {resp.status}"
            detail = ""
            if not resp.ok:
                try:
                    detail = json.loads(resp.body.decode()).get("message", "")
                except Exception:
                    detail = resp.body[:120].decode(errors="replace")
            print(f"    size {size:>3}: {verdict}  {detail}")
            report["batchCeiling"].append({"size": size, "accepted": resp.ok, "status": resp.status})

    # ---------------------------------------------------------------- 2. content in a batch
    print("\n  === can a batched job yield content? ===")
    tests = [
        (real[:1], None, "single id, no expand"),
        (real, None, f"{len(real)} ids, no expand"),
        (real, "dataActions", f"{len(real)} ids, expand=dataActions"),
        (real, "bots,dataActions", f"{len(real)} ids, expand=bots,dataActions"),
    ]
    for ids, expand, label in tests:
        if not ids:
            continue
        result = run_job(counter, client, ids, expand, label)
        report["contentTests"].append(result)
        print(
            f"    {label:<38} calls={result['calls']} entities={result.get('entities')} "
            f"withDownloadUri={result.get('entitiesWithDownloadUri')}"
        )
        if result.get("entityKeys"):
            print(f"      entity keys: {result['entityKeys']}")

    # ---------------------------------------------------------------- 3. cost model
    print("\n  === cost model ===")
    single = next((t for t in report["contentTests"] if t["size"] == 1), None)
    batched = next(
        (t for t in report["contentTests"] if t["size"] > 1 and t.get("expand") is None), None
    )
    if single:
        print(f"    calls to retrieve ONE execution via a single-id job : {single['calls']}")
    if batched and batched.get("entitiesWithDownloadUri"):
        per = batched["calls"] / batched["entitiesWithDownloadUri"]
        print(f"    calls per execution when batched                    : {per:.2f}")
    elif batched:
        print(
            "    a batched job returned no downloadUri, so content still costs one job "
            "per execution regardless of batch size"
        )
    if counter.last_rate:
        print(f"    rate-limit headers seen: {counter.last_rate}")
    print(f"    total API calls made by this probe: {counter.calls}")

    report["totalCalls"] = counter.calls
    report["rateLimitHeaders"] = counter.last_rate
    print(f"\n  Evidence: {gcapi.write_artifact('jobs-cost-model.json', report, subdir='validation')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
