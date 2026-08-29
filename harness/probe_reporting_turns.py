"""Baseline the Bot Flow Reporting Turns API before the turn-level metadata release.

Next week's Genesys Cloud release ("Turn-level metadata in the Bot Flow Reporting Turns API",
AI-1613) adds tool call, knowledge call, data action and guardrail metadata per AVA response turn
to this endpoint. This script records what the endpoint returns *today* for a given bot flow, so
that after the release the delta is a measured fact rather than a reading of the release note.

It also answers a question the architecture cares about independently of that release: whether
reporting turns exist for conversations whose flow execution never terminated. Those executions
produce no execution history and no notification, so if their turns are visible here, this endpoint
is a route to the population the pipeline is otherwise blind to.

Reproduce:
    python harness/probe_reporting_turns.py --flow-id <botFlowId> [--days 7]
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import datetime, timedelta, timezone

import gcapi

# The metadata the release is due to add, per the release note and the ticket's acceptance criteria.
EXPECTED_NEW = [
    "tool",
    "toolCall",
    "toolCalls",
    "knowledge",
    "knowledgeCall",
    "dataAction",
    "dataActionCall",
    "guardrail",
    "guardrails",
    "guardrailOutcome",
]


def keys_anywhere(node, out: Counter, path: str = "") -> Counter:
    if isinstance(node, dict):
        for k, v in node.items():
            out[k] += 1
            keys_anywhere(v, out, f"{path}.{k}")
    elif isinstance(node, list):
        for v in node:
            keys_anywhere(v, out, path)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--flow-id", required=True)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--page-size", type=int, default=50)
    args = ap.parse_args()

    client = gcapi.Client(gcapi.load_org_config())
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=args.days)
    interval = f"{start.strftime('%Y-%m-%dT%H:%M:%SZ')}/{end.strftime('%Y-%m-%dT%H:%M:%SZ')}"

    gcapi.banner("Bot Flow Reporting Turns - pre-release baseline")
    print(f"  flow     : {args.flow_id}")
    print(f"  interval : {interval}")

    resp = client.api(
        f"/api/v2/analytics/botflows/{args.flow_id}/reportingturns"
        f"?pageSize={args.page_size}&interval={interval}"
    )
    print(f"  status   : {resp.status}")
    if not resp.ok:
        print("  body:", resp.body[:600].decode(errors="replace"))
        return 1

    payload = resp.json()
    turns = payload.get("entities") or []
    print(f"  turns    : {len(turns)}")

    sessions = {t.get("sessionId") for t in turns if t.get("sessionId")}
    conversations = {t.get("conversationId") for t in turns if t.get("conversationId")}
    print(f"  sessions : {len(sessions)}")
    print(f"  conversationIds present on turns: {len(conversations)}")

    keys = keys_anywhere(turns, Counter())
    print(f"\n  distinct field names across all turns: {len(keys)}")
    for name, count in sorted(keys.items()):
        print(f"    {count:>4}  {name}")

    print("\n  === fields the coming release is due to add ===")
    for probe in EXPECTED_NEW:
        hit = next((k for k in keys if k.lower() == probe.lower()), None)
        print(f"    {'PRESENT' if hit else 'absent '}  {probe}")

    if turns:
        print("\n  === one full turn, verbatim ===")
        print(json.dumps(turns[0], indent=1)[:3000])

    artifact = gcapi.write_artifact(
        f"reporting-turns-baseline-{args.flow_id}.json",
        {
            "flowId": args.flow_id,
            "interval": interval,
            "status": resp.status,
            "turnCount": len(turns),
            "sessionCount": len(sessions),
            "conversationIdCount": len(conversations),
            "fieldNames": sorted(keys),
            "expectedNewFieldsPresent": {
                p: bool(next((k for k in keys if k.lower() == p.lower()), None))
                for p in EXPECTED_NEW
            },
            "sampleTurn": turns[0] if turns else None,
        },
        subdir="validation",
    )
    print(f"\n  Evidence: {artifact}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
