"""Enumerate every surface in this org that can yield AVA observability data.

The architecture was built around one notification topic and the Jobs API, on the assumption that
those are the only routes. That assumption was never tested against the platform's own topic
catalogue, and a push topic carrying richer AVA data would change the design completely - push
costs no API budget, which is the whole reason notifications are preferred over polling.

Three questions:

1. What notification topics exist that relate to flows, bots or agentic virtual agents? Reported
   with their schemas so a topic carrying tool or guardrail data would be visible as such.
2. What does the Bot Flow Sessions analytics endpoint return? It is a sibling of the reporting-turns
   endpoint and was never probed, and session-level outcomes in bulk are cheaper per conversation
   than anything execution-history based.
3. Which of the flow-instance query criteria this org actually permits, restated, since discovery
   cost feeds directly into the cost model.

Reproduce:
    python harness/probe_sources.py --flow-id <botFlowId>
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import gcapi

INTERESTING = re.compile(r"agentic|\bava\b|bot|flow|guardrail|tool|knowledge", re.IGNORECASE)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--flow-id", required=True)
    args = ap.parse_args()

    client = gcapi.Client(gcapi.load_org_config())
    report: dict = {}

    # ------------------------------------------------------------------ 1. topic catalogue
    gcapi.banner("Notification topic catalogue")
    resp = client.api("/api/v2/notifications/availabletopics?expand=schema&pageSize=500")
    if not resp.ok:
        print("  FAILED", resp.status, resp.body[:300].decode(errors="replace"))
        topics = []
    else:
        topics = resp.json().get("entities") or []
    print(f"  total topics visible to this client : {len(topics)}")

    matched = [t for t in topics if INTERESTING.search(t.get("id", ""))]
    print(f"  topics matching flow/bot/agentic    : {len(matched)}\n")

    by_family: dict[str, list] = defaultdict(list)
    for topic in matched:
        family = topic["id"].split(".")[1] if "." in topic["id"] else topic["id"]
        by_family[family].append(topic)

    for family in sorted(by_family):
        print(f"  --- {family}")
        for topic in sorted(by_family[family], key=lambda t: t["id"]):
            schema = json.dumps(topic.get("schema") or {})
            # Flag the fields that would make a topic useful for AVA explainability.
            signals = [
                s
                for s in ("tool", "guardrail", "knowledge", "dataAction", "executionHistoryUri", "turn")
                if s.lower() in schema.lower()
            ]
            print(
                f"    {topic['id']}"
                + (f"\n        publicApi={topic.get('publicApi')} "
                   f"requires={topic.get('requiresPermissions')}" if topic.get("requiresPermissions") else "")
                + (f"\n        SCHEMA SIGNALS: {signals}" if signals else "")
            )

    report["topicCount"] = len(topics)
    report["matchedTopics"] = [
        {
            "id": t["id"],
            "publicApi": t.get("publicApi"),
            "requiresPermissions": t.get("requiresPermissions"),
            "schemaSignals": [
                s
                for s in ("tool", "guardrail", "knowledge", "dataAction", "executionHistoryUri", "turn")
                if s.lower() in json.dumps(t.get("schema") or {}).lower()
            ],
        }
        for t in matched
    ]

    # ------------------------------------------------------------------ 2. bot flow sessions
    gcapi.banner("Bot Flow Sessions analytics endpoint")
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=2)
    interval = f"{start.strftime('%Y-%m-%dT%H:%M:%SZ')}/{end.strftime('%Y-%m-%dT%H:%M:%SZ')}"
    resp = client.api(
        f"/api/v2/analytics/botflows/{args.flow_id}/sessions?pageSize=50&interval={interval}"
    )
    print(f"  status: {resp.status}")
    if resp.ok:
        sessions = resp.json().get("entities") or []
        print(f"  sessions returned: {len(sessions)}")
        keys: set[str] = set()
        for s in sessions:
            keys |= set(s)
        print(f"  fields: {sorted(keys)}")
        if sessions:
            print("\n  one session verbatim:")
            print(json.dumps(sessions[0], indent=1)[:1800])
        report["botFlowSessions"] = {
            "status": resp.status,
            "count": len(sessions),
            "fields": sorted(keys),
            "sample": sessions[0] if sessions else None,
        }
    else:
        print("  body:", resp.body[:400].decode(errors="replace"))
        report["botFlowSessions"] = {"status": resp.status}

    # ------------------------------------------------------------------ 3. query capabilities
    gcapi.banner("Flow-instance query criteria permitted in this org")
    resp = client.api("/api/v2/flows/instances/querycapabilities")
    if resp.ok:
        criteria = [c["criteriaKey"] for c in resp.json().get("criteria") or []]
        print(f"  {len(criteria)} permitted: {criteria}")
        report["queryCriteria"] = criteria

    print(f"\n  Evidence: {gcapi.write_artifact('ava-data-sources.json', report, subdir='validation')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
