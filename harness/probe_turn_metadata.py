"""Measure which AVA turn-level metadata the Reporting Turns API returns, without reading content.

The 7 September 2026 release ("Enhanced AVA utterance history with turn-level triage metadata")
and the 19 October 2026 release ("Agentic Virtual Agent turn details in Journey Management")
both describe tool calls, knowledge calls, data action calls and guardrail outcomes per AVA turn.
The public OpenAPI definition declares `ReportingTurnToolCall`, `ReportingTurnGuardrailEvent` and
`ReportingTurnKnowledgeMetadata`, but `ReportingTurn` does not reference them, so only a live
response can say whether the data is delivered.

Turns carry customer utterances and bot prompts, so this script never prints values. It reports
the JSON paths present, how many turns carry each path, and the distinct values of a fixed
allowlist of enum-like fields. Nothing else leaves the process.

Reproduce:
    python harness/probe_turn_metadata.py --flow-id <botFlowId> [--days 10] [--max-pages 5]
"""

from __future__ import annotations

import argparse
import sys
import urllib.parse
from collections import Counter
from datetime import datetime, timedelta, timezone

import gcapi

# Paths whose values are platform enums or configuration names, never customer content.
ENUM_PATHS = {
    "askAction.actionType",
    "askActionResult",
    "sessionEndDetails.type",
    "sessionEndDetails.reason",
    "toolCalls[].status",
    "toolCalls[].toolType",
    "toolCalls[].origin",
    "guardrailEvents[].type",
    "toolCalls[].knowledgeMetadata.retrievalStatus",
    "toolCalls[].knowledgeMetadata.answerGenerationStatus",
}

METADATA_HINTS = ("tool", "guardrail", "knowledgemetadata", "agentdetails", "latency")


def collect_paths(node, prefix: str, paths: Counter, enums: dict[str, Counter]) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            path = f"{prefix}.{key}" if prefix else key
            collect_paths(value, path, paths, enums)
        return
    if isinstance(node, list):
        for value in node:
            collect_paths(value, f"{prefix}[]", paths, enums)
        return
    paths[prefix] += 1
    if prefix in ENUM_PATHS and isinstance(node, (str, bool, int)):
        enums.setdefault(prefix, Counter())[str(node)] += 1


def run_probe(flow_id: str, days: int, max_pages: int, division_aware: bool) -> int:
    client = gcapi.Client(gcapi.load_org_config())
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    interval = f"{start:%Y-%m-%dT%H:%M:%SZ}/{end:%Y-%m-%dT%H:%M:%SZ}"
    base = "divisions/reportingturns" if division_aware else "reportingturns"
    path = (
        f"/api/v2/analytics/botflows/{flow_id}/{base}"
        f"?pageSize=50&interval={urllib.parse.quote(interval, safe='')}"
    )

    gcapi.banner("Reporting Turns - turn-level AVA metadata probe")
    print(f"  flow      : {flow_id}")
    print(f"  endpoint  : {base}")
    print(f"  interval  : {days} days")

    turn_count = 0
    sessions: set[str] = set()
    sessions_with_conversation: set[str] = set()
    turn_paths: Counter = Counter()
    enums: dict[str, Counter] = {}
    calls = 0

    while path and calls < max_pages:
        resp = client.api(path)
        calls += 1
        if not resp.ok:
            print(f"  status    : {resp.status} on page {calls}")
            return 1
        payload = resp.json()
        for turn in payload.get("entities") or []:
            turn_count += 1
            session_id = turn.get("sessionId")
            if session_id:
                sessions.add(session_id)
                if (turn.get("conversation") or {}).get("id"):
                    sessions_with_conversation.add(session_id)
            per_turn: Counter = Counter()
            collect_paths(turn, "", per_turn, enums)
            for key in per_turn:
                turn_paths[key] += 1
        next_uri = payload.get("nextUri")
        path = next_uri if next_uri and next_uri.startswith("/api/") else None

    print(f"  api calls : {calls}")
    print(f"  turns     : {turn_count}")
    print(f"  sessions  : {len(sessions)} ({len(sessions_with_conversation)} with conversation id)")

    print("\n  === paths present (turns carrying each) ===")
    for key in sorted(turn_paths):
        marker = "*" if any(h in key.lower() for h in METADATA_HINTS) else " "
        print(f"  {marker} {turn_paths[key]:>4}  {key}")

    print("\n  === enum values (allowlisted paths only) ===")
    for key in sorted(enums):
        values = ", ".join(f"{value}={count}" for value, count in enums[key].most_common())
        print(f"    {key}: {values}")

    metadata_paths = [k for k in turn_paths if any(h in k.lower() for h in METADATA_HINTS)]
    print(f"\n  turn-level AVA metadata paths: {len(metadata_paths)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--flow-id", required=True)
    parser.add_argument("--days", type=int, default=10)
    parser.add_argument("--max-pages", type=int, default=5)
    parser.add_argument("--legacy", action="store_true", help="use the non-division endpoint")
    args = parser.parse_args()
    try:
        return run_probe(args.flow_id, args.days, args.max_pages, not args.legacy)
    except SystemExit as exc:
        print(f"  stopped: {type(exc).__name__}")
        return 1
    except Exception as exc:  # noqa: BLE001 - never echo payloads or messages
        line = exc.__traceback__.tb_lineno if exc.__traceback__ else "?"
        print(f"  probe failed: {type(exc).__name__} at line {line}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
