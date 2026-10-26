"""Invoke the Reporting Turns sweep and summarise what it stored, as metadata only.

Run through the aws skill so credentials stay inside the helper process:

    $py = "$env:USERPROFILE\\.cursor\\skills\\aws\\.venv\\Scripts\\python.exe"
    powershell -File $env:USERPROFILE\\.cursor\\skills\\aws\\scripts\\aws-exec.ps1 -Region eu-central-1 -Quiet `
        -Run "$py scripts\\invoke-turns-sweep.py"

Prints the sweep's own counts, then per-flow watermark status and session totals. Never prints
turn content: no user input, prompts or tool errors.
"""

from __future__ import annotations

import argparse
import json
import sys

FUNCTION_NAME = "ava-explain-turns-sweep"
TABLE_NAME = "ava-explain-turns"


def invoke_sweep(lambda_client, flow_ids: list[str]) -> None:
    payload = json.dumps({"flowIds": flow_ids} if flow_ids else {}).encode()
    response = lambda_client.invoke(FunctionName=FUNCTION_NAME, Payload=payload)
    print(f"  invoke    : status {response.get('StatusCode')}{' FunctionError' if response.get('FunctionError') else ''}")
    if response.get("FunctionError"):
        return
    result = json.loads(response["Payload"].read() or b"{}")
    for key in ("runId", "flows", "swept", "failed", "skipped", "incomplete", "pages", "turns", "sessions"):
        print(f"  {key:<10}: {result.get(key)}")


def summarise_table(table) -> None:
    sweeps = table.query(IndexName="day-index", KeyConditionExpression="#d = :d",
                         ExpressionAttributeNames={"#d": "day"}, ExpressionAttributeValues={":d": "SWEEP"})["Items"]
    with_turns = [item for item in sweeps if int(item.get("lastRunTurns") or 0) > 0]
    errors = [item for item in sweeps if item.get("lastError")]
    print(f"  watermarks: {len(sweeps)} flows, {len(with_turns)} with turns this run, {len(errors)} with errors")
    for item in with_turns:
        print(f"    flow {item['flowId']}: {item.get('lastRunTurns')} turns, {item.get('lastRunSessions')} sessions, complete={item.get('lastRunComplete')}")
    for item in errors[:10]:
        print(f"    flow {item['flowId']}: error {str(item.get('lastError'))[:80]}")

    sessions = tool_calls = failures = with_conversation = 0
    days: dict[str, int] = {}
    scan_kwargs = {"ProjectionExpression": "pk, #d, toolCallCount, toolFailureCount, conversationId",
                   "ExpressionAttributeNames": {"#d": "day"}}
    while True:
        page = table.scan(**scan_kwargs)
        for item in page["Items"]:
            if not str(item.get("pk", "")).startswith("SESSION#"):
                continue
            sessions += 1
            tool_calls += int(item.get("toolCallCount") or 0)
            failures += int(item.get("toolFailureCount") or 0)
            with_conversation += 1 if item.get("conversationId") else 0
            days[item.get("day") or "?"] = days.get(item.get("day") or "?", 0) + 1
        if "LastEvaluatedKey" not in page:
            break
        scan_kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    print(f"  sessions  : {sessions} stored, {with_conversation} with conversation id, {tool_calls} tool calls, {failures} tool failures")
    for day in sorted(days):
        print(f"    {day}: {days[day]}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--flow-id", action="append", default=[], help="Sweep only these flows.")
    parser.add_argument("--summary-only", action="store_true", help="Skip the invoke.")
    args = parser.parse_args()
    try:
        import boto3
        from botocore.config import Config

        if not args.summary_only:
            invoke_sweep(boto3.client("lambda", config=Config(read_timeout=330, retries={"max_attempts": 0})), args.flow_id)
        summarise_table(boto3.resource("dynamodb").Table(TABLE_NAME))
        return 0
    except Exception as exc:  # noqa: BLE001 - fixed message only, never the exception text
        line = exc.__traceback__.tb_lineno if exc.__traceback__ else "?"
        print(f"  failed    : {type(exc).__name__} at line {line}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
