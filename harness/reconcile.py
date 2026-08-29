"""VALIDATION 12 - does the event stream actually deliver one notification per execution?

This is the gate the whole architecture rests on. Every other mechanism - the collector, the
manifest, the Bronze layout - assumes that a flow execution reliably produces a notification.
If that assumption is false the pipeline is not merely slow, it is silently incomplete, and no
amount of retry logic inside the collector can recover an event that was never sent.

The check needs a known-good expected set, which is what makes `drive_bot_flow.py` the
precondition: it records exactly which flow executions were created, so this script can compare
three populations rather than two.

  driven      - executions we know were created, from the batch artifact
  genesys     - executions the platform will still return data for, via the bulk Jobs API
  manifest    - executions the pipeline actually received a notification for

A gap between `driven` and `genesys` would mean execution data was never retained. A gap between
`genesys` and `manifest` means the notification was lost in delivery - the platform still has the
data, so the loss is recoverable, but only if you know to go looking. That is the difference
between a pipeline that needs a reconciliation sweep and one that does not.

Needs boto3, so run it through the aws skill wrapper's venv:
  powershell -File %USERPROFILE%\\.cursor\\skills\\aws\\scripts\\aws-exec.ps1 -Region eu-central-1 ^
    -Run "%USERPROFILE%\\.cursor\\skills\\aws\\.venv\\Scripts\\python.exe harness\\reconcile.py --latest-batch"
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import time
from pathlib import Path

import gcapi

DRIVEN = Path(__file__).resolve().parent.parent / "artifacts" / "driven"

# The Jobs API accepts a batch of ids. Kept well below any plausible server limit so that a 400
# here means something real rather than an argument about batch sizing.
JOBS_BATCH = 50


def collect_expected(args: argparse.Namespace) -> tuple[list[str], str | None]:
    if args.session_id:
        return list(args.session_id), None
    pattern = str(DRIVEN / "botflow-batch-*.json")
    batches = sorted(glob.glob(pattern))
    if not batches:
        raise SystemExit(f"no batch artifacts found at {pattern}\nRun drive_bot_flow.py --sessions N")
    chosen = batches if args.all_batches else batches[-1:]
    ids: list[str] = []
    excluded = 0

    def keep(record: dict) -> bool:
        """Only executions that reached the flow's own exit are expected to be observable.

        A session force-disconnected while the bot was still waiting for input produces no
        execution history and no event, so counting it as expected reports a delivery miss that
        says nothing about the pipeline. Older artifacts predate the flag; absent means keep, which
        preserves their original reading.
        """
        nonlocal excluded
        if record.get("flowReachedOwnExit") is False:
            excluded += 1
            return False
        return True

    for path in chosen:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        results = data.get("results") or []
        if results:
            ids.extend(r["sessionId"] for r in results if r.get("sessionId") and keep(r))
        else:
            ids.extend(data.get("sessionIds") or [])
    # Single sessions are written as botflow-session-*.json rather than batches.
    if args.include_singles:
        for path in sorted(glob.glob(str(DRIVEN / "botflow-session-*.json"))):
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            if data.get("sessionId") and keep(data):
                ids.append(data["sessionId"])
    if excluded:
        print(
            f"  excluded {excluded} session(s) that never reached the flow's own exit "
            f"(no history is produced for those, so they are not delivery misses)"
        )
    return sorted(set(ids)), ", ".join(Path(p).name for p in chosen)


def run_job(client: gcapi.Client, chunk: list[str], timeout_s: int) -> tuple[list, dict]:
    """Submit one Jobs request and poll it to a terminal state."""
    resp = client.api("/api/v2/flows/instances/jobs", method="POST", payload={"ids": chunk})
    if not resp.ok:
        return [], {
            "size": len(chunk),
            "accepted": False,
            "error": f"{resp.status} {resp.error}",
            "body": resp.body[:300].decode(errors="replace"),
        }
    job_id = resp.json()["id"]
    deadline = time.time() + timeout_s
    state = None
    entities: list = []
    while time.time() < deadline:
        poll = client.api(f"/api/v2/flows/instances/jobs/{job_id}")
        if not poll.ok:
            break
        payload = poll.json()
        state = payload.get("jobState")
        if state in ("Success", "Failed"):
            entities = payload.get("entities") or []
            break
        time.sleep(3)
    return entities, {
        "size": len(chunk),
        "accepted": True,
        "jobId": job_id,
        "jobState": state,
        "entities": len(entities),
        "entityKeys": sorted(entities[0].keys()) if entities else [],
    }


def genesys_present(client: gcapi.Client, ids: list[str], timeout_s: int = 300) -> tuple[set, dict]:
    """Ask the platform which of these executions it will still return data for.

    The Jobs API is all-or-nothing: a batch containing a single id it will not accept fails the
    whole request with 422 and no indication of which id was at fault. Batching naively therefore
    reports every execution as absent, which looks exactly like catastrophic data loss. So a
    failed batch is bisected down to singletons, which both isolates the real answer per id and
    measures how large a usable batch is.

    A job reaching Success does NOT mean the platform holds data for the ids in it. The job
    reports per-id outcomes: an id with no retained data comes back as an entity carrying
    `failed: true, statusCode: "404"` and no `downloadUri`, in an otherwise successful job. A
    completely invented uuid comes back exactly the same way, so treating "job succeeded with
    entities" as presence marks every id present and turns this check into a rubber stamp.
    Presence is therefore read from the per-entity outcome, not from the job state.
    """
    present: set[str] = set()
    detail: dict = {"batches": [], "rejectedIndividually": []}

    def attempt(chunk: list[str]) -> None:
        entities, meta = run_job(client, chunk, timeout_s)
        detail["batches"].append(meta)
        if meta.get("accepted"):
            seen: set[str] = set()
            for entity in entities:
                found = entity.get("executionId") or entity.get("id")
                if not found:
                    continue
                seen.add(found)
                if entity.get("failed"):
                    detail["rejectedIndividually"].append(
                        {"id": found, "reason": f"statusCode {entity.get('statusCode')}"}
                    )
                else:
                    present.add(found)
            # Entities without a usable id, or ids the job did not report on at all, leave the
            # answer unknown for those ids rather than absent. Bisecting resolves them to
            # singletons where the id is unambiguous.
            unreported = [i for i in chunk if i not in seen]
            if unreported and len(chunk) > 1:
                bisect(unreported)
            elif unreported:
                detail["rejectedIndividually"].append(
                    {"id": chunk[0], "reason": "job reported no entity for this id"}
                )
            return
        if len(chunk) == 1:
            detail["rejectedIndividually"].append({"id": chunk[0], "reason": meta.get("error")})
            return
        bisect(chunk)

    def bisect(chunk: list[str]) -> None:
        mid = len(chunk) // 2
        attempt(chunk[:mid])
        attempt(chunk[mid:])

    for start in range(0, len(ids), JOBS_BATCH):
        attempt(ids[start : start + JOBS_BATCH])

    accepted_sizes = [b["size"] for b in detail["batches"] if b.get("accepted")]
    detail["largestAcceptedBatch"] = max(accepted_sizes) if accepted_sizes else 0
    return present, detail


def manifest_present(table: str, org_id: str, ids: list[str]) -> tuple[set, dict]:
    import boto3

    ddb = boto3.client("dynamodb")
    present: set[str] = set()
    statuses: dict[str, str] = {}
    for execution_id in ids:
        item = ddb.get_item(
            TableName=table,
            Key={"pk": {"S": f"{org_id}:{execution_id}"}},
        ).get("Item")
        if item:
            present.add(execution_id)
            statuses[execution_id] = item.get("status", {}).get("S", "?")
    return present, statuses


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--session-id", action="append", help="explicit execution id; repeatable")
    ap.add_argument("--latest-batch", action="store_true", help="use the newest batch artifact")
    ap.add_argument("--all-batches", action="store_true", help="use every batch artifact")
    ap.add_argument("--include-singles", action="store_true", help="also include single-session runs")
    ap.add_argument("--table", default=os.environ.get("MANIFEST_TABLE", "ava-explain-manifest"))
    ap.add_argument("--skip-genesys", action="store_true")
    ap.add_argument("--ca-bundle")
    args = ap.parse_args()

    expected, source = collect_expected(args)
    if not expected:
        raise SystemExit("no expected execution ids resolved")

    config = gcapi.load_org_config()
    client = gcapi.Client(config, ca_bundle=args.ca_bundle)
    org_id = client.api("/api/v2/organizations/me").json()["id"]

    gcapi.banner(f"VALIDATION 12 - reconciliation over {len(expected)} driven executions")
    if source:
        print(f"  source   : {source}")
    print(f"  org      : {org_id}")
    print(f"  table    : {args.table}")

    in_genesys: set[str] = set()
    genesys_detail: dict = {"skipped": True}
    if not args.skip_genesys:
        print("\n  Querying the platform (bulk Jobs) ...")
        in_genesys, genesys_detail = genesys_present(client, expected)
        print(f"    platform will return data for {len(in_genesys)}/{len(expected)}")

    print("\n  Reading the manifest ...")
    in_manifest, statuses = manifest_present(args.table, org_id, expected)
    print(f"    manifest has {len(in_manifest)}/{len(expected)}")

    missing_from_manifest = sorted(set(expected) - in_manifest)
    missing_from_genesys = sorted(set(expected) - in_genesys) if not args.skip_genesys else []

    print("\n  === Per-execution ===")
    for execution_id in expected:
        genesys_mark = "-" if args.skip_genesys else ("yes" if execution_id in in_genesys else "NO ")
        manifest_mark = "yes" if execution_id in in_manifest else "NO "
        print(
            f"    {execution_id}  platform={genesys_mark}  manifest={manifest_mark}"
            f"  {statuses.get(execution_id, '')}"
        )

    delivery_rate = len(in_manifest) / len(expected) * 100
    print("\n  === Verdict ===")
    print(f"  driven            : {len(expected)}")
    if not args.skip_genesys:
        print(f"  platform retained : {len(in_genesys)}")
    print(f"  notified          : {len(in_manifest)}")
    print(f"  delivery rate     : {delivery_rate:.1f}%")

    if missing_from_manifest and not missing_from_genesys and not args.skip_genesys:
        print()
        print(f"  {len(missing_from_manifest)} execution(s) exist in the platform but never produced")
        print("  a notification. The event stream is therefore NOT a complete record of")
        print("  executions, and a reconciliation sweep is mandatory rather than defensive.")
    elif not missing_from_manifest:
        print("\n  Every driven execution produced a notification.")

    if statuses:
        counts: dict[str, int] = {}
        for value in statuses.values():
            counts[value] = counts.get(value, 0) + 1
        print(f"\n  manifest statuses : {counts}")

    out = gcapi.write_artifact(
        f"v12-reconcile-{int(time.time())}.json",
        {
            "orgId": org_id,
            "table": args.table,
            "source": source,
            "driven": expected,
            "platformRetained": sorted(in_genesys),
            "notified": sorted(in_manifest),
            "missingFromManifest": missing_from_manifest,
            "missingFromPlatform": missing_from_genesys,
            "deliveryRatePct": round(delivery_rate, 2),
            "manifestStatuses": statuses,
            "genesysDetail": genesys_detail,
        },
    )
    print(f"\n  Evidence: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
