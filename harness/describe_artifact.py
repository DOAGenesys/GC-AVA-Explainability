"""Describe the STRUCTURE of a downloaded execution-history artifact, not its content.

This is the evidence for validation 10 (AVA field completeness) and validation 11 (truncation),
and it is structure-only by design: the artifacts contain real conversation content from a
shared production org recorded at level `All`, so this prints paths, types and counts, and
redacts leaf values unless --show-values is passed explicitly.

Also reports directly on the questions section 2 of the architecture asks: can the normalised
model actually be reconstructed from this? For each required entity it looks for evidence and
says present or absent.

Usage:
  python harness/describe_artifact.py --file artifacts/validation/<id>-job-default-0.json
  python harness/describe_artifact.py --execution-id <id>
  python harness/describe_artifact.py --execution-id <id> --show-values   # careful: real data
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import gcapi

# What section 2 of the architecture says must be reconstructable. The patterns are deliberately
# generous: the point is to find out what vocabulary Genesys actually uses, not to assert one.
REQUIRED_EVIDENCE = {
    "flow identity": r"flowid|flowname|flowversion|flowtype",
    "execution identity": r"^\$?\.?(id|executionid)$|executionid",
    "conversation correlation": r"conversationid",
    "ordered action sequence": r"action|item|step|sequence",
    "action/tool identity": r"actionid|actionname|objectid|objecttype|toolname|tooltype",
    "action inputs": r"input|request|parameter|argument",
    "action outputs": r"output|result|response|returnvalue",
    "data action calls": r"dataaction|integration",
    "knowledge calls": r"knowledge|document|article|search",
    "guardrail events": r"guardrail|blocked|policy|violation",
    "bot / AVA detail": r"bot|agent|virtualagent|ava|intent|slot|utterance",
    "timing / latency": r"starttime|startdate|endtime|enddate|duration|latency|elapsed|ms$",
    "status": r"status|state|success|failed|outcome",
    "errors": r"error",
    "warnings": r"warning",
    "exit reason": r"exitreason|disconnect|termination",
    "truncation markers": r"valueistoolarge|truncat|toolarge",
    "nested flow linkage": r"parent|caller|invoking|child|subflow",
}


def walk(node: Any, path: str = "$", out: list[tuple[str, Any]] | None = None) -> list[tuple[str, Any]]:
    if out is None:
        out = []
    if isinstance(node, dict):
        for key, value in node.items():
            walk(value, f"{path}.{key}", out)
    elif isinstance(node, list):
        for i, item in enumerate(node):
            walk(item, f"{path}[{i}]", out)
    else:
        out.append((path, node))
    return out


def shape(path: str) -> str:
    return re.sub(r"\[\d+\]", "[]", path)


def redact(value: Any, show: bool) -> str:
    if show:
        return str(value)[:120]
    if value is None:
        return "null"
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    return f"<{len(text)} chars>"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--file")
    ap.add_argument("--execution-id")
    ap.add_argument("--show-values", action="store_true", help="print real content; handle with care")
    ap.add_argument("--max-paths", type=int, default=80)
    args = ap.parse_args()

    if args.file:
        path = Path(args.file)
    elif args.execution_id:
        base = gcapi.ARTIFACTS / "validation"
        candidates = sorted(base.glob(f"{args.execution_id}-job-default-*.json")) or sorted(
            base.glob(f"{args.execution_id}-*.json")
        )
        if not candidates:
            raise SystemExit(f"no artifact found for {args.execution_id}")
        path = candidates[0]
    else:
        raise SystemExit("pass --file or --execution-id")

    data = json.loads(path.read_text(encoding="utf-8-sig"))
    leaves = walk(data)

    gcapi.banner(f"Structure of {path.name}  ({path.stat().st_size:,} bytes)")

    print(f"  leaf values : {len(leaves)}")
    shapes = Counter(shape(p) for p, _ in leaves)
    print(f"  distinct paths (list indices collapsed): {len(shapes)}")

    if isinstance(data, dict):
        print(f"\n  top-level keys: {sorted(data.keys())}")

    # ------------------------------------------------------------- array cardinality
    arrays: dict[str, int] = defaultdict(int)
    for p, _ in leaves:
        for match in re.finditer(r"^(.*?)\[(\d+)\]", p):
            prefix, index = match.group(1), int(match.group(2))
            arrays[prefix] = max(arrays[prefix], index + 1)
    if arrays:
        print("\n  arrays and their observed length:")
        for prefix, length in sorted(arrays.items(), key=lambda kv: -kv[1])[:20]:
            print(f"    {length:>5}  {prefix}")

    # ---------------------------------------------------- architecture section 2 check
    print("\n  === Can the section 2 explainability model be reconstructed? ===")
    all_shapes = list(shapes.keys())
    present, absent = [], []
    for label, pattern in REQUIRED_EVIDENCE.items():
        rx = re.compile(pattern, re.I)
        matches = [s for s in all_shapes if rx.search(s)]
        if matches:
            present.append((label, matches))
        else:
            absent.append(label)

    for label, matches in present:
        sample = ", ".join(sorted(set(m.split(".")[-1] for m in matches))[:6])
        print(f"    [yes] {label:<28} {len(matches):>3} path(s)  e.g. {sample}")
    for label in absent:
        print(f"    [NO ] {label:<28} no matching path in this artifact")

    # ----------------------------------------------------------- truncation (v11)
    truncation = [(p, v) for p, v in leaves if re.search(r"toolarge|truncat", p, re.I)]
    print(f"\n  truncation markers present: {len(truncation)}")
    for p, v in truncation[:10]:
        print(f"    {p} = {v}")

    # ------------------------------------------------------------------ path listing
    print(f"\n  === Distinct paths (first {args.max_paths}) ===")
    by_shape: dict[str, Any] = {}
    for p, v in leaves:
        by_shape.setdefault(shape(p), v)
    for shape_path in sorted(by_shape)[: args.max_paths]:
        value = by_shape[shape_path]
        kind = type(value).__name__
        print(f"    {shape_path:<62} {kind:<6} {redact(value, args.show_values)}")
    if len(by_shape) > args.max_paths:
        print(f"    ... and {len(by_shape) - args.max_paths} more")

    report = {
        "artifact": path.name,
        "bytes": path.stat().st_size,
        "leafCount": len(leaves),
        "distinctPaths": len(shapes),
        "topLevelKeys": sorted(data.keys()) if isinstance(data, dict) else None,
        "arrayLengths": dict(arrays),
        "section2Present": {label: matches for label, matches in present},
        "section2Absent": absent,
        "truncationMarkers": [{"path": p, "value": v} for p, v in truncation],
        "allPaths": sorted(by_shape),
    }
    out = gcapi.write_artifact(f"structure-{path.stem}.json", report)
    print(f"\n  Evidence: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
