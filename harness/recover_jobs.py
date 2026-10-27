"""Retrieve execution history for manifest rows the collector could not download.

The collector marks a row `RECOVERY_REQUIRED` when the notification carries no
`executionHistoryUri`. Validation 5 established that this is not an occasional error but the
observed default - the field was populated on none of the delivered events - so this sweep is not
a fallback. It is the only thing that ever puts execution history into Bronze, and without it the
pipeline captures envelopes and nothing else.

The retrieval route is the bulk Jobs API, chosen over the notification's `endpoint` field because
`endpoint` creates one job per execution and cannot batch (validation 4).

Two behaviours are inherited from the validation work rather than rediscovered here:

  - Batches are all-or-nothing. A batch containing one unacceptable id fails with a bare 422
    naming no id, so a failed batch is bisected rather than abandoned (validation 6).
  - A batched job's entities DO carry `downloadUri`, one per entity, against a ceiling of 10 ids
    per job. This sweep still fetches content per execution because a low-volume backfill values
    per-execution error attribution over call count; the production collector batches instead.

Run through the aws skill wrapper's venv:
  powershell -File %USERPROFILE%\\.cursor\\skills\\aws\\scripts\\aws-exec.ps1 -Region eu-central-1 ^
    -Run "%USERPROFILE%\\.cursor\\skills\\aws\\.venv\\Scripts\\python.exe harness\\recover_jobs.py --apply"
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from datetime import datetime, timezone

import boto3

import gcapi

BATCH = 10  # measured acceptance ceiling: 10 accepted, 11 rejected 422. See validation 6.
TERMINAL = ("Success", "Failed")


def scan_manifest(ddb, table: str, status: str, limit: int) -> list[dict]:
    rows: list[dict] = []
    kwargs: dict = {
        "TableName": table,
        "FilterExpression": "#s = :s",
        "ExpressionAttributeNames": {"#s": "status"},
        "ExpressionAttributeValues": {":s": {"S": status}},
    }
    while True:
        page = ddb.scan(**kwargs)
        for item in page.get("Items", []):
            rows.append(
                {
                    "pk": item["pk"]["S"],
                    "orgId": item["pk"]["S"].split(":", 1)[0],
                    "executionId": item.get("executionId", {}).get("S")
                    or item["pk"]["S"].split(":", 1)[1],
                    "occurredAt": item.get("occurredAt", {}).get("S", ""),
                    "status": item.get("status", {}).get("S"),
                }
            )
            if len(rows) >= limit:
                return rows
        token = page.get("LastEvaluatedKey")
        if not token:
            return rows
        kwargs["ExclusiveStartKey"] = token


def submit(client: gcapi.Client, ids: list[str], timeout_s: int) -> tuple[dict, dict]:
    """Return (status_by_execution_id, meta) for one Jobs batch."""
    resp = client.api("/api/v2/flows/instances/jobs", method="POST", payload={"ids": ids})
    if not resp.ok:
        return {}, {"size": len(ids), "accepted": False, "error": f"{resp.status} {resp.error}"}
    job_id = resp.json()["id"]
    deadline = time.time() + timeout_s
    entities: list = []
    state = None
    while time.time() < deadline:
        poll = client.api(f"/api/v2/flows/instances/jobs/{job_id}")
        if not poll.ok:
            return {}, {"size": len(ids), "accepted": True, "jobId": job_id,
                        "error": f"poll {poll.status}"}
        payload = poll.json()
        state = payload.get("jobState")
        if state in TERMINAL:
            entities = payload.get("entities") or []
            break
        time.sleep(3)
    result = {}
    for entity in entities:
        execution_id = entity.get("id")
        if execution_id:
            result[execution_id] = {
                "statusCode": entity.get("statusCode"),
                "failed": entity.get("failed"),
                "downloadUri": entity.get("downloadUri"),
            }
    return result, {"size": len(ids), "accepted": True, "jobId": job_id, "jobState": state,
                    "entities": len(entities)}


def submit_bisecting(client: gcapi.Client, ids: list[str], timeout_s: int, meta: list) -> dict:
    combined: dict = {}
    results, info = submit(client, ids, timeout_s)
    meta.append(info)
    if info.get("accepted") and results:
        combined.update(results)
        return combined
    if len(ids) == 1:
        return combined
    mid = len(ids) // 2
    combined.update(submit_bisecting(client, ids[:mid], timeout_s, meta))
    combined.update(submit_bisecting(client, ids[mid:], timeout_s, meta))
    return combined


def fetch_single(client: gcapi.Client, execution_id: str, timeout_s: int) -> bytes | None:
    """Fetch one execution's history via a single-id job.

    NOTE: one job per execution is 10x more API calls than necessary. A batched job returns a
    downloadUri per entity - measured on batches of 4, with and without `expand`, against a
    ceiling of 10 ids per job (validation 6). The earlier belief that only single-id jobs yield a
    URI came from batches whose entities were 404 failures. This function is kept because a
    recovery sweep is a low-volume background task where per-execution error attribution is worth
    more than call count, but a production collector must batch instead.
    """
    results, info = submit(client, [execution_id], timeout_s)
    uri = (results.get(execution_id) or {}).get("downloadUri")
    if not uri:
        return None
    blob = gcapi.request(uri)
    return blob.body if blob.ok else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--table", default="ava-explain-manifest")
    ap.add_argument("--bucket", help="defaults to $BRONZE_BUCKET, else derived from the caller's account")
    ap.add_argument("--status", default="RECOVERY_REQUIRED")
    ap.add_argument(
        "--execution-id",
        action="append",
        help="recover these executions regardless of manifest state; repeatable. This is the "
        "backfill path for executions that never produced a notification at all, which the "
        "manifest by definition has no row for.",
    )
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--apply", action="store_true", help="write to S3 and update the manifest")
    ap.add_argument("--ca-bundle")
    args = ap.parse_args()
    args.bucket = gcapi.bronze_bucket(args.bucket)

    ddb = boto3.client("dynamodb")
    s3 = boto3.client("s3")
    client = gcapi.Client(gcapi.load_org_config(), ca_bundle=args.ca_bundle)

    org_id = client.api("/api/v2/organizations/me").json()["id"]

    if args.execution_id:
        gcapi.banner(f"Jobs recovery - {len(args.execution_id)} explicit execution(s)")
        rows = [
            {
                "pk": f"{org_id}:{execution_id}",
                "orgId": org_id,
                "executionId": execution_id,
                "occurredAt": "",
                "status": "BACKFILL",
            }
            for execution_id in args.execution_id
        ]
    else:
        gcapi.banner(f"Jobs recovery sweep - status={args.status}")
        rows = scan_manifest(ddb, args.table, args.status, args.limit)
    print(f"  rows to recover : {len(rows)}")
    if not rows:
        print("  nothing to do")
        return 0
    if not args.apply:
        print("  DRY RUN - pass --apply to write to Bronze and update the manifest")

    ids = [r["executionId"] for r in rows]
    by_id = {r["executionId"]: r for r in rows}

    print("\n  Establishing retrievability via bulk Jobs ...")
    meta: list = []
    retrievable: dict = {}
    for start in range(0, len(ids), BATCH):
        retrievable.update(submit_bisecting(client, ids[start : start + BATCH], args.timeout, meta))
    # An id the platform holds nothing for still comes back as an entity, flagged
    # `failed: true, statusCode: "404"`, inside a job that reached Success. Counting entities
    # rather than successful entities reports every id as retrievable.
    retrievable = {k: v for k, v in retrievable.items() if not v.get("failed")}
    accepted_sizes = [m["size"] for m in meta if m.get("accepted")]
    print(f"    {len(retrievable)}/{len(ids)} retrievable")
    print(f"    {len(meta)} job(s) submitted, largest accepted batch {max(accepted_sizes, default=0)}")

    recovered = 0
    failed: list[str] = []
    print("\n  Fetching artifacts ...")
    for execution_id in ids:
        if execution_id not in retrievable:
            failed.append(execution_id)
            print(f"    {execution_id}  NOT RETRIEVABLE")
            continue
        blob = fetch_single(client, execution_id, args.timeout)
        if not blob:
            failed.append(execution_id)
            print(f"    {execution_id}  no artifact")
            continue
        digest = hashlib.sha256(blob).hexdigest()
        row = by_id[execution_id]
        occurred = row["occurredAt"] or datetime.now(timezone.utc).isoformat()
        day = occurred[:10]
        key = f"bronze/history-jobs/dt={day}/org={row['orgId']}/{execution_id}.json"
        print(f"    {execution_id}  {len(blob):>7} bytes  sha256 {digest[:12]}...  -> {key}")
        if args.apply:
            s3.put_object(
                Bucket=args.bucket, Key=key, Body=blob, ContentType="application/json"
            )
            ddb.update_item(
                TableName=args.table,
                Key={"pk": {"S": row["pk"]}},
                UpdateExpression=(
                    "SET #s = :s, historyKey = :k, historyBytes = :b, historySha256 = :h, "
                    "recoveredAt = :t, recoveryRoute = :r"
                ),
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":s": {"S": "ARCHIVED"},
                    ":k": {"S": key},
                    ":b": {"N": str(len(blob))},
                    ":h": {"S": digest},
                    ":t": {"S": datetime.now(timezone.utc).isoformat()},
                    # Backfilled rows are written by this sweep rather than by the collector, so
                    # the route distinguishes "we had an event and could not download it" from
                    # "there was never an event and reconciliation found the gap".
                    ":r": {"S": "jobs-backfill" if args.execution_id else "jobs-bulk"},
                },
            )
        recovered += 1

    print("\n  === Verdict ===")
    print(f"  recovered : {recovered}/{len(rows)}")
    print(f"  failed    : {len(failed)}")
    if not args.apply:
        print("  (dry run - nothing was written)")

    out = gcapi.write_artifact(
        f"jobs-recovery-{int(time.time())}.json",
        {
            "table": args.table,
            "bucket": args.bucket,
            "applied": args.apply,
            "requested": ids,
            "recovered": recovered,
            "failed": failed,
            "jobs": meta,
        },
    )
    print(f"\n  Evidence: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
