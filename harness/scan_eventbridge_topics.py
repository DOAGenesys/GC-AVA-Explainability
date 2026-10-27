"""Inventory every notification topic EventBridge can deliver, and what its event schema carries.

Answers one question: could an EventBridge-only pipeline (no API calls back to Genesys) capture
AVA explainability content - turns, prompts, tool calls with inputs and outputs, guardrails,
knowledge? It walks each topic's published JSON schema and reports the field paths that match
AVA-relevant terms.

    python harness\\scan_eventbridge_topics.py

Writes the full path inventory to artifacts/validation/eventbridge-topic-schemas.json and prints a
summary. Prints schema field names only; no event data is fetched.
"""

from __future__ import annotations

import re
import sys
from typing import Any

import gcapi

TERMS = re.compile(
    r"tool|guardrail|turn|knowledge|prompt|userinput|utterance|intent|dataaction|history|"
    r"transcript|agentic|virtualagent|\bbot|llm|summary|input|output|execution|messagebody|"
    r"\btext\b|body",
    re.IGNORECASE,
)
MAX_DEPTH = 12


def collect_definitions(node: Any, defs: dict[str, dict]) -> None:
    if isinstance(node, dict):
        if isinstance(node.get("id"), str) and node.get("type") == "object":
            defs.setdefault(node["id"], node)
        for value in node.values():
            collect_definitions(value, defs)
    elif isinstance(node, list):
        for value in node:
            collect_definitions(value, defs)


def walk(node: Any, path: str, defs: dict[str, dict], seen: tuple[str, ...], out: set[str]) -> None:
    if not isinstance(node, dict) or len(seen) > MAX_DEPTH:
        return
    ref = node.get("$ref")
    if isinstance(ref, str):
        if ref in seen or ref not in defs:
            return
        walk(defs[ref], path, defs, seen + (ref,), out)
        return
    for name, child in (node.get("properties") or {}).items():
        child_path = f"{path}.{name}" if path else name
        out.add(child_path)
        walk(child, child_path, defs, seen, out)
    if isinstance(node.get("items"), dict):
        walk(node["items"], f"{path}[]", defs, seen, out)
    if isinstance(node.get("additionalProperties"), dict):
        walk(node["additionalProperties"], f"{path}{{}}", defs, seen, out)


def main() -> int:
    try:
        client = gcapi.Client(gcapi.load_org_config())
        resp = client.api("/api/v2/notifications/availabletopics?expand=transports,schema&includePreview=true")
        if not resp.ok:
            print(f"  failed    : availabletopics returned {resp.status}")
            return 1
        topics = resp.json().get("entities") or []
        transports: dict[str, int] = {}
        for topic in topics:
            for transport in topic.get("transports") or []:
                transports[transport] = transports.get(transport, 0) + 1
        eventbridge = [
            t for t in topics
            if any(str(x).lower() in ("all", "eventbridge") for x in (t.get("transports") or []))
        ]
        print(f"  topics    : {len(topics)} total; transports {transports}")
        print(f"  eventbridge-capable: {len(eventbridge)}")

        inventory = []
        for topic in sorted(eventbridge, key=lambda t: t.get("id", "")):
            schema = topic.get("schema") or {}
            defs: dict[str, dict] = {}
            collect_definitions(schema, defs)
            paths: set[str] = set()
            walk(schema, "", defs, (), paths)
            hits = sorted(p for p in paths if TERMS.search(p.split(".")[-1].replace("[]", "")))
            inventory.append({"topic": topic.get("id"), "description": topic.get("description"),
                              "transports": topic.get("transports"), "fieldCount": len(paths),
                              "relevantFields": hits, "fields": sorted(paths)})

        gcapi.write_artifact("eventbridge-topic-schemas.json", inventory)
        no_schema = [t["topic"] for t in inventory if t["fieldCount"] == 0]
        print(f"  without schema fields: {len(no_schema)}")
        for item in inventory:
            topic = str(item["topic"])
            if not item["relevantFields"]:
                continue
            if not re.search(r"flow|bot|conversation|analytics|detail|transcri|summar|speech|journey|workflow", topic):
                continue
            print(f"\n  {topic}  ({item['fieldCount']} fields)")
            for field in item["relevantFields"][:40]:
                print(f"      {field}")
            if len(item["relevantFields"]) > 40:
                print(f"      ... {len(item['relevantFields']) - 40} more")
        return 0
    except Exception as exc:  # noqa: BLE001 - fixed message only
        line = exc.__traceback__.tb_lineno if exc.__traceback__ else "?"
        print(f"  failed    : {type(exc).__name__} at line {line}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
