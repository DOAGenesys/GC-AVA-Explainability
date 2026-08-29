"""Find flow executions already inside Genesys's 10-day retention window.

This exists because the Jobs half of the validation work does not need the event pipeline to be
receiving traffic. Execution-data storage has been on in this org since 2024 at level `All`, so
a population of real executions exists right now, and querying it unblocks validation 2
immediately rather than waiting for ambient flow traffic.

Two search strategies, because the obvious one is weak:

  --by-flow          POST /flows/instances/query with a FlowId criterion. Reliable but only
                     useful if you already know a flow that ran recently; idle demo flows
                     return nothing, which is most of them.

  (default)          Walk recent conversations from the analytics API, then resolve each one's
                     flow executions by ConversationId. This finds what actually ran, rather
                     than guessing, and is how you locate AVA executions in a shared org whose
                     59 AVA flows are used sporadically.

Two contract details, both learned the hard way and both worth keeping:

  1. The criteria vocabulary in the OpenAPI enum is a global superset. What an org may actually
     query comes from GET /flows/instances/querycapabilities, and asking for anything outside it
     fails with 400 "Attempting to query with unallowed capabilities". In this org that means
     FlowStartDateTime / FlowEndDateTime are NOT available, so the architecture's statement that
     the query API cannot filter by datetime is correct here even though the enum suggests
     otherwise.
  2. The execution identifier in a query result is `id`, not `executionId`.

Usage:
  python harness/find_executions.py                        # walk recent conversations
  python harness/find_executions.py --days 3 --limit 100
  python harness/find_executions.py --by-flow
  python harness/find_executions.py --capabilities         # what this org may query on
  python harness/find_executions.py --definition CriteriaQuery
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone

import gcapi

QUERY_PATH = "/api/v2/flows/instances/query"


# ------------------------------------------------------------------ contract inspection


def show_capabilities(client: gcapi.Client) -> int:
    gcapi.banner("What this org is permitted to query on")
    resp = client.api("/api/v2/flows/instances/querycapabilities")
    if not resp.ok:
        raise SystemExit(f"querycapabilities failed: {resp.status}")
    data = resp.json()
    keys = []
    for crit in data.get("criteria") or []:
        keys.append(crit["criteriaKey"])
        print(f"  {crit['criteriaKey']:<28} {crit['dataType']:<8} operators={crit['operators']}")
    print(f"\n  {len(keys)} criteria available.")
    for absent in ("FlowStartDateTime", "FlowEndDateTime", "BotId", "FlowType"):
        if absent not in keys:
            print(f"  NOT available here: {absent}")
    gcapi.write_artifact("query-capabilities.json", data)
    return 0


def describe_definition(client: gcapi.Client, root: str) -> int:
    url = f"https://{client.config.api_host}/api/v2/docs/swagger"
    resp = gcapi.request(url, timeout=300, ca_bundle=client.ca_bundle)
    if not resp.ok:
        raise SystemExit(f"could not read swagger: {resp.status}")
    definitions = resp.json().get("definitions") or {}

    gcapi.banner(f"Definition: {root}")
    seen: set[str] = set()

    def show(name: str, depth: int = 0) -> None:
        if name in seen or depth > 4:
            return
        seen.add(name)
        definition = definitions.get(name)
        if not definition:
            print(f"{'  ' * depth}{name}: NOT FOUND")
            return
        required = definition.get("required") or []
        pad = "  " * depth
        print(f"{pad}{name}")
        nested: list[str] = []
        for prop, meta in (definition.get("properties") or {}).items():
            items = meta.get("items") or {}
            ref = meta.get("$ref") or items.get("$ref")
            kind = meta.get("type", "object")
            if items:
                kind = f"array<{items.get('type') or (ref or '').split('/')[-1]}>"
            flag = " (required)" if prop in required else ""
            enum = meta.get("enum") or items.get("enum")
            line = f"{pad}  {prop}: {kind}{flag}"
            if enum:
                line += f"  enum={enum}"
            print(line)
            if ref:
                nested.append(ref.split("/")[-1])
        for child in nested:
            print()
            show(child, depth + 1)

    show(root)
    return 0


# ---------------------------------------------------------------------------- searching


def query_instances(client: gcapi.Client, key: str, value: str, page_size: int = 25) -> list[dict]:
    """CriteriaQuery: query[] of CriteriaGroup, each with and/or/not arrays of
    CriteriaItem {key, operator, value}. Note `value` is singular."""
    payload = {"query": [{"and": [{"key": key, "operator": "eq", "value": value}]}]}
    resp = client.api(f"{QUERY_PATH}?pageSize={page_size}", method="POST", payload=payload)
    if not resp.ok:
        body = resp.body[:200].decode("utf-8", errors="replace")
        print(f"    query {key}={value[:8]}... failed {resp.status}: {body}")
        return []
    return resp.json().get("entities") or []


def load_ava_flow_ids() -> dict[str, str]:
    path = gcapi.ARTIFACTS / "ava-flow-registry.json"
    if not path.is_file():
        print("  (no AVA flow registry; AVA flagging disabled. Build it with")
        print("   scripts\\gc-build-ava-registry.ps1)")
        return {}
    registry = json.loads(path.read_text(encoding="utf-8-sig"))
    return {f["id"]: f["name"] for f in registry.get("avaFlows", [])}


def recent_conversations(client: gcapi.Client, days: int, limit: int) -> list[str]:
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    interval = (
        f"{start.strftime('%Y-%m-%dT%H:%M:%S.000Z')}/{end.strftime('%Y-%m-%dT%H:%M:%S.000Z')}"
    )

    ids: list[str] = []
    page = 1
    while len(ids) < limit:
        payload = {
            "interval": interval,
            "order": "desc",
            "paging": {"pageSize": min(100, limit), "pageNumber": page},
        }
        resp = client.api(
            "/api/v2/analytics/conversations/details/query", method="POST", payload=payload
        )
        if not resp.ok:
            print(f"  analytics query failed {resp.status}")
            break
        conversations = resp.json().get("conversations") or []
        if not conversations:
            break
        ids.extend(c["conversationId"] for c in conversations)
        page += 1
    return ids[:limit]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=3, help="how far back to walk conversations")
    ap.add_argument("--limit", type=int, default=60, help="conversations to inspect")
    ap.add_argument("--by-flow", action="store_true", help="query by FlowId instead")
    ap.add_argument("--flow-id", help="one specific flow id (implies --by-flow)")
    ap.add_argument("--max-flows", type=int, default=15)
    ap.add_argument("--capabilities", action="store_true")
    ap.add_argument("--definition")
    ap.add_argument("--ca-bundle")
    args = ap.parse_args()

    client = gcapi.Client(gcapi.load_org_config(), ca_bundle=args.ca_bundle)

    if args.capabilities:
        return show_capabilities(client)
    if args.definition:
        return describe_definition(client, args.definition)

    ava_flows = load_ava_flow_ids()
    found: list[dict] = []

    if args.by_flow or args.flow_id:
        if args.flow_id:
            targets = [(args.flow_id, "(specified)")]
        else:
            targets = list(ava_flows.items())[: args.max_flows]
        gcapi.banner(f"Querying {len(targets)} flow(s) by FlowId")
        for flow_id, name in targets:
            entities = query_instances(client, "FlowId", flow_id)
            print(f"  {len(entities):>3} execution(s)  {name[:50]}")
            found.extend(entities)
    else:
        gcapi.banner(f"Walking conversations from the last {args.days} day(s)")
        conversation_ids = recent_conversations(client, args.days, args.limit)
        print(f"  {len(conversation_ids)} conversation(s) to resolve")
        for i, conversation_id in enumerate(conversation_ids, 1):
            entities = query_instances(client, "ConversationId", conversation_id)
            found.extend(entities)
            if i % 10 == 0 or i == len(conversation_ids):
                print(f"    {i}/{len(conversation_ids)} resolved, {len(found)} execution(s) so far")

    # Deduplicate: a conversation can hold several executions, and nested flows appear twice.
    unique: dict[str, dict] = {}
    for item in found:
        execution_id = item.get("id") or item.get("executionId")
        if execution_id:
            unique[execution_id] = item

    executions = []
    for execution_id, item in unique.items():
        flow_id = item.get("flowId")
        executions.append(
            {
                "executionId": execution_id,
                "flowId": flow_id,
                "flowName": item.get("flowName"),
                "flowType": item.get("flowType"),
                "flowVersion": item.get("flowVersion"),
                "conversationId": item.get("conversationId"),
                "startDateTime": item.get("startDateTime"),
                "endDateTime": item.get("endDateTime"),
                "flowErrorReason": item.get("flowErrorReason"),
                "isAvaFlow": flow_id in ava_flows,
            }
        )
    executions.sort(key=lambda e: str(e.get("startDateTime") or ""), reverse=True)

    ava_executions = [e for e in executions if e["isAvaFlow"]]

    print(f"\n  Unique executions: {len(executions)}")
    print(f"  On AVA-enabled flows: {len(ava_executions)}")

    if executions:
        by_type: dict[str, int] = {}
        for e in executions:
            by_type[str(e["flowType"])] = by_type.get(str(e["flowType"]), 0) + 1
        print("\n  By flow type:")
        for kind, count in sorted(by_type.items(), key=lambda kv: -kv[1]):
            print(f"    {count:>4}  {kind}")

        print("\n  Newest 15:")
        for e in executions[:15]:
            flag = " [AVA]" if e["isAvaFlow"] else ""
            print(
                f"    {e['executionId']}  {str(e.get('startDateTime'))[:19]}  "
                f"{str(e.get('flowType')):<12} {str(e.get('flowName'))[:34]}{flag}"
            )

    out = gcapi.write_artifact(
        "executions-found.json",
        {
            "foundAt": datetime.now(timezone.utc).isoformat(),
            "total": len(executions),
            "avaCount": len(ava_executions),
            "executions": executions,
        },
    )
    print(f"\n  Evidence: {out}")

    if ava_executions:
        print("\n  Next - answer validation 2 on a real AVA execution:")
        print(f"    python harness/jobs_compare.py --execution-id {ava_executions[0]['executionId']}")
    elif executions:
        print("\n  No AVA-flow executions in this window, but the Jobs path can still be")
        print("  exercised and its artifact structure characterised on any execution:")
        print(f"    python harness/jobs_compare.py --execution-id {executions[0]['executionId']}")
        return 0

    return 0 if executions else 1


if __name__ == "__main__":
    raise SystemExit(main())
