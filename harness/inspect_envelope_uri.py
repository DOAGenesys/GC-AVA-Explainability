"""Report whether the EventBridge envelope for an execution carried a populated executionHistoryUri.

Reads the manifest row the collector wrote for the execution, then the envelope it archived
verbatim under bronze/envelope/, and prints metadata only. The URI is a pre-signed credential, so
it is never printed: only absent / null / empty / present, its length and its host.

Run through the aws skill so credentials stay in the child process:

    aws-exec.ps1 -Region eu-central-1 -Quiet -Run "<venv python> harness/inspect_envelope_uri.py
        --execution-id <id> [--wait 300]"
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from urllib.parse import urlsplit

import boto3

TABLE = "ava-explain-manifest"
BUCKET_PREFIX = "ava-explain-bronze-"
MANIFEST_FIELDS = (
    "status", "flowId", "flowType", "flowVersion", "flowExitReason", "executionItemsTruncated",
    "executionHistoryUriTtl", "calculatedExpiryAt", "eventReceivedAt", "collectorVersion",
    "duplicateDeliveries", "detailType", "retrievalMethod", "historyBytes",
)


def find_manifest_row(ddb, execution_id: str) -> dict | None:
    kwargs = {
        "TableName": TABLE,
        "FilterExpression": "executionId = :e",
        "ExpressionAttributeValues": {":e": {"S": execution_id}},
    }
    while True:
        page = ddb.scan(**kwargs)
        if page.get("Items"):
            return page["Items"][0]
        if "LastEvaluatedKey" not in page:
            return None
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def describe_uri(body: dict) -> dict:
    if "executionHistoryUri" not in body:
        return {"state": "absent"}
    uri = body["executionHistoryUri"]
    if uri is None:
        return {"state": "null"}
    if not isinstance(uri, str):
        return {"state": f"non-string ({type(uri).__name__})"}
    if not uri.strip():
        return {"state": "empty string"}
    return {"state": "present", "length": len(uri), "host": urlsplit(uri).hostname}


def describe_envelope(envelope: dict) -> dict:
    detail = envelope.get("detail") or {}
    body = detail.get("eventBody") if isinstance(detail.get("eventBody"), dict) else detail
    execution = body.get("execution")
    return {
        "detailType": envelope.get("detail-type"),
        "topicName": detail.get("topicName"),
        "eventBodyKeys": sorted(body.keys()),
        "executionHistoryUri": describe_uri(body),
        "executionHistoryUriTtl": body.get("executionHistoryUriTtl"),
        "executionItemsTruncated": body.get("executionItemsTruncated"),
        "executionItemCount": len(execution) if isinstance(execution, list) else None,
        "flowExitReason": body.get("flowExitReason"),
        "flowType": body.get("flowType"),
        "endpointPresent": bool(body.get("endpoint")),
        "errorCount": len(body.get("errors") or []),
        "warningCount": len(body.get("warnings") or []),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--execution-id", required=True)
    ap.add_argument("--wait", type=int, default=0, help="seconds to poll for the manifest row")
    args = ap.parse_args()

    try:
        ddb = boto3.client("dynamodb")
        s3 = boto3.client("s3")
        deadline = time.monotonic() + args.wait
        row = find_manifest_row(ddb, args.execution_id)
        while row is None and time.monotonic() < deadline:
            time.sleep(15)
            row = find_manifest_row(ddb, args.execution_id)
        if row is None:
            print(json.dumps({"executionId": args.execution_id, "manifestRow": "not found"}))
            return 2

        report = {
            "executionId": args.execution_id,
            "manifest": {k: next(iter(row[k].values())) for k in MANIFEST_FIELDS if k in row},
        }
        key = row.get("envelopeKey", {}).get("S")
        bucket = next(
            (b["Name"] for b in s3.list_buckets()["Buckets"] if b["Name"].startswith(BUCKET_PREFIX)),
            None,
        )
        if key and bucket:
            envelope = json.loads(s3.get_object(Bucket=bucket, Key=key)["Body"].read())
            report["envelope"] = describe_envelope(envelope)
        else:
            report["envelope"] = "envelope key or bucket not found"
        print(json.dumps(report, indent=2, default=str))
        return 0
    except Exception as exc:  # noqa: BLE001 - only the type and line are safe to show
        tb = exc.__traceback__
        while tb and tb.tb_next:
            tb = tb.tb_next
        print(f"inspection failed: {type(exc).__name__} at line {tb.tb_lineno if tb else '?'}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
