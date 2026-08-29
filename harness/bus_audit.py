"""Audit every event that reached the partner event bus, across all log streams.

`pipeline-status.ps1` samples only the newest few log streams, which is fine as a health check
but cannot support a claim about loss: an undercount there is indistinguishable from an event
that was never delivered. This reads the whole discovery log group over an explicit window so
that "Genesys never sent it" can be separated from "it arrived and our rule did not match it".

That distinction decides where the fix goes. Events on the bus but absent from the manifest is
our routing bug. Events absent from the bus is a platform delivery property, and no amount of
AWS-side work will recover them.

Run through the aws skill wrapper's venv:
  powershell -File %USERPROFILE%\\.cursor\\skills\\aws\\scripts\\aws-exec.ps1 -Region eu-central-1 ^
    -Run "%USERPROFILE%\\.cursor\\skills\\aws\\.venv\\Scripts\\python.exe harness\\bus_audit.py --hours 3"
"""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter

import boto3

import gcapi

DEFAULT_LOG_GROUP = "/aws/events/ava-explain/raw"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--log-group", default=DEFAULT_LOG_GROUP)
    ap.add_argument("--hours", type=float, default=3.0)
    args = ap.parse_args()

    logs = boto3.client("logs")
    start_ms = int((time.time() - args.hours * 3600) * 1000)

    gcapi.banner(f"Bus audit - {args.log_group}, last {args.hours}h (all streams)")

    paginator = logs.get_paginator("filter_log_events")
    events: list[dict] = []
    streams: set[str] = set()
    try:
        for page in paginator.paginate(logGroupName=args.log_group, startTime=start_ms):
            for entry in page.get("events", []):
                streams.add(entry.get("logStreamName", "?"))
                try:
                    events.append(json.loads(entry["message"]))
                except json.JSONDecodeError:
                    continue
    except logs.exceptions.ResourceNotFoundException:
        print(f"  log group {args.log_group} does not exist yet - no event has ever arrived")
        return 1

    print(f"  streams scanned : {len(streams)}")
    print(f"  events on bus   : {len(events)}")

    by_type = Counter(e.get("detail-type", "?") for e in events)
    print("\n  by detail-type")
    for name, count in by_type.most_common():
        print(f"    {count:5}  {name}")

    rows = []
    for event in events:
        body = ((event.get("detail") or {}).get("eventBody")) or {}
        rows.append(
            {
                "eventTime": event.get("time"),
                "executionId": body.get("executionId"),
                "flowId": body.get("flowId"),
                "flowType": body.get("flowType"),
                "exitReason": body.get("flowExitReason"),
                "truncated": body.get("executionItemsTruncated"),
                "hasHistoryUri": bool(body.get("executionHistoryUri")),
                "historyUriTtl": body.get("executionHistoryUriTtl"),
                "hasEndpoint": bool(body.get("endpoint")),
                "executionItems": len(body.get("execution") or []),
            }
        )
    rows.sort(key=lambda r: r["eventTime"] or "")

    print("\n  events, oldest first")
    for row in rows:
        print(
            f"    {row['eventTime']}  {row['executionId']}  {row['flowType']:11}"
            f"  items={row['executionItems']:3}  truncated={row['truncated']}"
            f"  historyUri={row['hasHistoryUri']}  endpoint={row['hasEndpoint']}"
        )

    with_uri = sum(1 for r in rows if r["hasHistoryUri"])
    print("\n  === Field population across every delivered event ===")
    print(f"  executionHistoryUri present : {with_uri}/{len(rows)}")
    print(f"  endpoint present            : {sum(1 for r in rows if r['hasEndpoint'])}/{len(rows)}")
    print(f"  executionItemsTruncated     : {sum(1 for r in rows if r['truncated'])}/{len(rows)}")

    # Per-flow gaps are what reveal whether delivery is selective rather than absent.
    by_flow = Counter(r["flowId"] for r in rows)
    print("\n  by flowId")
    for flow_id, count in by_flow.most_common():
        print(f"    {count:5}  {flow_id}")

    out = gcapi.write_artifact(
        f"bus-audit-{int(time.time())}.json",
        {
            "logGroup": args.log_group,
            "windowHours": args.hours,
            "streamsScanned": len(streams),
            "eventCount": len(events),
            "byDetailType": dict(by_type),
            "byFlowId": dict(by_flow),
            "eventsWithHistoryUri": with_uri,
            "events": rows,
        },
    )
    print(f"\n  Evidence: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
