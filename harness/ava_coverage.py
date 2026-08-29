"""VALIDATIONS 10 and 11 - AVA field completeness across scenarios, and truncation impact.

Scans every downloaded execution-history artifact and answers two questions:

  V10: for each scenario in the architecture's matrix, is the required evidence present in the
       artifacts we hold? Reported as observed / not observed, never as "unsupported" - absence
       here means no captured execution exercised that scenario, which is exactly why the
       architecture calls for a purpose-built test AVA.

  V11: do stored values actually hit the documented limits (JSON 1,000 chars, string 253 chars,
       collection 20 items)? Measures the real distribution rather than trusting the doc, and
       flags anything at or near a limit.

The headline number is the tool-output one. Data Action responses arrive as a JSON string in
`dataAction.successOutput`, so the 1,000-character JSON limit is what decides whether the
Genesys record alone is sufficient for explainability, or whether Section 10's tool-boundary
telemetry becomes mandatory.

Structure and measurement only. No conversation content is printed or written.

Usage:
  python harness/ava_coverage.py
  python harness/ava_coverage.py --dir artifacts/validation
"""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import gcapi

# Documented historical-execution limits, from section 10 of the architecture.
JSON_LIMIT = 1000
STRING_LIMIT = 253
COLLECTION_LIMIT = 20

# The architecture's validation 10 matrix. Each scenario maps to the artifact evidence that
# would demonstrate it.
SCENARIO_EVIDENCE = {
    "Data Action success": "toolWithSuccessOutput",
    "Data Action timeout": "toolTimeout",
    "Data Action error": "toolError",
    "Guardrail block": "guardrail",
    "Knowledge lookup": "knowledge",
    "AVA containment": "exitContained",
    "Human handoff": "escalation",
    "Customer escalation": "escalation",
    "Nested flow invocation": "nestedFlow",
    "Voice bot flow": "voiceTurn",
    "Digital bot flow": "digitalTurn",
}


def walk(node: Any, path: str = "$"):
    """Yield (path, key, value) for every node, so both keys and leaves can be inspected."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield f"{path}.{key}", key, value
            yield from walk(value, f"{path}.{key}")
    elif isinstance(node, list):
        for i, item in enumerate(node):
            yield from walk(item, f"{path}[{i}]")


def analyse(data: dict) -> dict:
    findings: dict[str, Any] = {
        "signals": set(),
        "tools": [],
        "strings": [],
        "collections": [],
        "actionTypes": Counter(),
        "exitReasons": [],
        "truncationFlags": [],
    }

    for path, key, value in walk(data):
        lower = key.lower()

        if key.startswith("action") or key.startswith("event") or key.startswith("started") or key.startswith("ended"):
            findings["actionTypes"][key] += 1

        if key == "actionCallAgenticVirtualAgent":
            findings["signals"].add("avaInvocation")
        if key == "eventAgentEscalation" or "escalat" in lower:
            findings["signals"].add("escalation")
        if "knowledge" in lower or "article" in lower:
            findings["signals"].add("knowledge")
        if "guardrail" in lower or "blocked" in lower or "violation" in lower:
            findings["signals"].add("guardrail")
        if key == "flowExecutionId" or key == "objectExecutionId" or key == "actionCallTask":
            findings["signals"].add("nestedFlow")
        if key == "digital" or key == "digitalItems":
            findings["signals"].add("digitalTurn")
        if key in ("audio", "audioItems", "tts", "speech"):
            findings["signals"].add("voiceTurn")
        # Deliberately strict. A flow variable merely *named* something with "timeout" in it is
        # not a timed-out tool call, and an empty failureOutputs array is not an error. Loose
        # matching here produced false "observed" verdicts on the two scenarios that matter most
        # for error-path explainability, which is worse than reporting them as not observed.
        if lower in ("timeout", "timedout", "istimeout") and value is True:
            findings["signals"].add("toolTimeout")
        if key == "errorOutputs" and value:
            findings["signals"].add("toolError")
        if key == "failureOutputs" and isinstance(value, list) and len(value) > 0:
            findings["signals"].add("toolError")
        if key in ("errorCode", "errorMessage", "flowEventError") and value:
            findings["signals"].add("toolError")
        if "valueistoolarge" in lower or "istruncated" in lower or "truncat" in lower:
            findings["truncationFlags"].append({"path": path, "value": value})

        if key == "exitReason" and isinstance(value, str):
            findings["exitReasons"].append(value)

        # tool invocations
        if key == "tools" and isinstance(value, list):
            for tool in value:
                if not isinstance(tool, dict):
                    continue
                data_action = tool.get("dataAction") or {}
                success = data_action.get("successOutput")
                record = {
                    "toolName": bool(tool.get("toolName")),
                    "toolId": bool(tool.get("toolId")),
                    "toolExecutionId": bool(tool.get("toolExecutionId")),
                    "hasStart": bool(tool.get("startDateTime")),
                    "hasEnd": bool(tool.get("endDateTime")),
                    "inputFieldCount": len(data_action.get("input") or {}),
                    "successOutputChars": len(success) if isinstance(success, str) else None,
                    "isSecure": data_action.get("isSecure"),
                    "keys": sorted(tool.keys()),
                }
                findings["tools"].append(record)
                if success:
                    findings["signals"].add("toolWithSuccessOutput")

        if isinstance(value, str) and key not in ("successOutput",):
            findings["strings"].append(len(value))
        if isinstance(value, list):
            findings["collections"].append(len(value))

    if any(r in ("CONTAINED", "Contained", "contained") for r in findings["exitReasons"]):
        findings["signals"].add("exitContained")

    return findings


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--dir",
        action="append",
        help="directory of history artifacts; repeatable. Defaults to both the validation reports "
        "directory and the Bronze pull directory, because scanning only one of them silently "
        "under-reports scenario coverage.",
    )
    args = ap.parse_args()

    bases = [Path(d) for d in (args.dir or [gcapi.ARTIFACTS / "validation", gcapi.ARTIFACTS / "history"])]
    # Identify artifacts by shape rather than by filename. The harness writes its own reports into
    # the same directories, and scanning those made this script analyse its own output - phantom
    # action types and phantom truncation flags. Filename matching fixed that but was tied to
    # jobs_compare's naming, so artifacts recovered from Bronze (named <executionId>.json) were
    # silently skipped, which is worse: an empty scan reads as "scenario not observed".
    def is_history_artifact(path: Path) -> bool:
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except (json.JSONDecodeError, UnicodeDecodeError, OSError):
            return False
        return isinstance(data, dict) and isinstance(data.get("flow"), dict)

    candidates = [p for b in bases for p in sorted(Path(b).glob("*.json")) if is_history_artifact(p)]
    if not candidates:
        raise SystemExit(f"no execution-history artifacts in {', '.join(str(b) for b in bases)}")

    # The same execution is held several times over: jobs_compare writes one file per `expand`
    # variant, and Bronze pulls duplicate what the compare runs already downloaded. Counting all of
    # them multiplies every gate 11 statistic by however many copies happen to exist - "20 tool
    # invocations" across 5 distinct executions - and inflates confidence in exactly the numbers
    # this gate exists to measure. Deduplicate on the execution identity, keeping the first copy.
    files: list[Path] = []
    seen: set[str] = set()
    duplicates = 0
    for path in candidates:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
        flow = data.get("flow") or {}
        identity = flow.get("flowExecutionId") or flow.get("executionId")
        if not identity:
            identity = hashlib.sha256(path.read_bytes()).hexdigest()
        if identity in seen:
            duplicates += 1
            continue
        seen.add(identity)
        files.append(path)

    gcapi.banner(f"VALIDATIONS 10 and 11 across {len(files)} distinct execution(s)")
    if duplicates:
        print(f"  ignored {duplicates} duplicate copy/copies of executions already counted\n")

    all_signals: set[str] = set()
    all_tools: list[dict] = []
    all_strings: list[int] = []
    all_collections: list[int] = []
    action_types: Counter = Counter()
    exit_reasons: Counter = Counter()
    truncation: list[dict] = []
    per_file: list[dict] = []

    for path in files:
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError:
            print(f"  skipping unparseable {path.name}")
            continue
        result = analyse(data)
        all_signals |= result["signals"]
        all_tools.extend(result["tools"])
        all_strings.extend(result["strings"])
        all_collections.extend(result["collections"])
        action_types.update(result["actionTypes"])
        exit_reasons.update(result["exitReasons"])
        truncation.extend(result["truncationFlags"])
        per_file.append(
            {
                "artifact": path.name,
                "bytes": path.stat().st_size,
                "toolCount": len(result["tools"]),
                "signals": sorted(result["signals"]),
            }
        )
        print(f"  {path.name[:52]:<52} {path.stat().st_size:>7,}b  {len(result['tools'])} tool(s)")

    # ------------------------------------------------------------------ V10 matrix
    print("\n  === VALIDATION 10 - scenario coverage in the artifacts held ===")
    covered, missing = [], []
    for scenario, signal in SCENARIO_EVIDENCE.items():
        if signal in all_signals:
            covered.append(scenario)
            print(f"    [observed    ] {scenario}")
        else:
            missing.append(scenario)
            print(f"    [not observed] {scenario}")
    print(f"\n    {len(covered)} of {len(SCENARIO_EVIDENCE)} scenarios observed.")
    if missing:
        print("    Not observed does not mean unsupported: no captured execution exercised")
        print("    these. A purpose-built test AVA is the only way to produce them on demand.")

    print(f"\n  Action/event types seen across all artifacts ({len(action_types)}):")
    for name, count in action_types.most_common(30):
        print(f"    {count:>5}  {name}")

    if exit_reasons:
        print("\n  Exit reasons observed:")
        for reason, count in exit_reasons.most_common():
            print(f"    {count:>5}  {reason}")

    # -------------------------------------------------------------- V11 truncation
    print("\n  === VALIDATION 11 - do values reach the documented limits? ===")

    outputs = [t["successOutputChars"] for t in all_tools if t["successOutputChars"] is not None]
    print(f"\n  Tool invocations captured: {len(all_tools)}")
    if outputs:
        print(f"  dataAction.successOutput length (chars), n={len(outputs)}:")
        print(f"    min {min(outputs)}  median {int(statistics.median(outputs))}  max {max(outputs)}")
        # "At or over" and "near but under" support opposite conclusions, so they must not share
        # a branch. A response stored intact *above* the documented limit is evidence the limit
        # does not bind; one just below it is evidence of nothing either way.
        over_limit = [n for n in outputs if n > JSON_LIMIT]
        near_limit = [n for n in outputs if JSON_LIMIT - 50 <= n <= JSON_LIMIT]
        print(f"    over the {JSON_LIMIT}-char JSON limit : {len(over_limit)}")
        print(f"    within 50 chars but under it     : {len(near_limit)}")
        if over_limit:
            print(f"    => responses of up to {max(over_limit)} chars are stored INTACT, so the")
            print(f"       documented {JSON_LIMIT}-char JSON limit does not bind this field.")
            print("       Section 10 tool-boundary telemetry stays OPTIONAL on this evidence.")
        elif near_limit:
            print("    => responses are close to the limit without exceeding it, so this sample")
            print("       cannot say whether the limit binds. A deliberate oversized payload is")
            print("       still required.")
        else:
            print(f"    => no sampled response came near {JSON_LIMIT} chars, so nothing here is")
            print("       yet truncated. This is NOT proof of safety: it reflects the response")
            print("       sizes of the AVAs that happened to run. Validation 11 still needs a")
            print("       deliberate oversized payload.")

    complete = [t for t in all_tools if t["toolName"] and t["hasStart"] and t["hasEnd"]]
    print(f"\n  Tools with name + start + end (latency derivable): {len(complete)}/{len(all_tools)}")
    with_input = [t for t in all_tools if t["inputFieldCount"] > 0]
    print(f"  Tools with captured input fields                 : {len(with_input)}/{len(all_tools)}")
    with_output = [t for t in all_tools if t["successOutputChars"]]
    print(f"  Tools with captured output payload               : {len(with_output)}/{len(all_tools)}")

    if all_strings:
        long_strings = [n for n in all_strings if n >= STRING_LIMIT]
        print(f"\n  String values at/over the {STRING_LIMIT}-char limit: {len(long_strings)} of {len(all_strings)}")
        print(f"    longest observed: {max(all_strings)} chars")
        if max(all_strings) > STRING_LIMIT:
            print(f"    => strings longer than {STRING_LIMIT} ARE stored, so that documented limit")
            print("       does not apply uniformly to every field in this artifact type.")

    if all_collections:
        big = [n for n in all_collections if n >= COLLECTION_LIMIT]
        print(f"\n  Collections at/over {COLLECTION_LIMIT} items: {len(big)} of {len(all_collections)}")
        print(f"    largest observed: {max(all_collections)} items")

    print(f"\n  Explicit truncation flags found: {len(truncation)}")
    flag_values = Counter(str(t["value"]) for t in truncation)
    for value, count in flag_values.most_common():
        print(f"    {count:>5}  = {value}")

    report = {
        "artifactCount": len(files),
        "scenariosObserved": covered,
        "scenariosNotObserved": missing,
        "actionTypes": dict(action_types),
        "exitReasons": dict(exit_reasons),
        "toolCount": len(all_tools),
        "toolsWithLatency": len(complete),
        "toolsWithInput": len(with_input),
        "toolsWithOutput": len(with_output),
        "successOutputChars": {
            "n": len(outputs),
            "min": min(outputs) if outputs else None,
            "median": int(statistics.median(outputs)) if outputs else None,
            "max": max(outputs) if outputs else None,
            "jsonLimit": JSON_LIMIT,
        },
        "longestString": max(all_strings) if all_strings else None,
        "largestCollection": max(all_collections) if all_collections else None,
        "truncationFlags": flag_values,
        "perArtifact": per_file,
    }
    out = gcapi.write_artifact("v10-v11-coverage.json", report)
    print(f"\n  Evidence: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
