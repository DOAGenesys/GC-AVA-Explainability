"""VALIDATION 1 - is the direct signed download semantically equivalent to the Jobs artifact?

The pass condition from the architecture is deliberately asymmetric: the direct download must
contain everything the richest Jobs artifact contains. Extra fields on either side are fine,
and byte equality is not required, because serialisation may legitimately differ.

So this reports directionally:

  MISSING  - a leaf path present in the Jobs artifact and absent from the direct download.
             These are the only findings that can fail the gate.
  EXTRA    - present in direct, absent in Jobs. Informational.
  DIFFERENT- present in both, different values. Informational unless it is an AVA field,
             since timestamps and ids legitimately vary between retrievals.

Findings are also classified by whether they touch AVA explainability, because a missing
`selfUri` is noise and a missing tool output is a blocker.

Usage:
  python harness/semantic_diff.py --execution-id <id>
  python harness/semantic_diff.py --direct a.json --jobs b.json
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

import gcapi

# Paths matching this are the ones the explainability product depends on. A difference here
# is a finding; a difference anywhere else is usually retrieval metadata.
AVA_SIGNIFICANT = re.compile(
    r"tool|action|dataaction|knowledge|guardrail|bot|agent|intent|slot|input|output|request"
    r"|response|payload|value|error|warning|status|outcome|exit|latency|duration|elapsed"
    r"|truncat|toolarge|blocked|reason|prompt|completion|model",
    re.I,
)

# Values that legitimately differ between two retrievals of the same execution.
VOLATILE = re.compile(r"selfuri|downloaduri|expir|signature|correlation|retrievedat|generatedat", re.I)


def flatten(node: Any, path: str = "$") -> dict[str, Any]:
    """Flatten to leaf paths. Lists are indexed, because order is itself meaningful here -
    the architecture needs the ordered tool sequence, so $.items[3] vs $.items[7] matters."""
    out: dict[str, Any] = {}
    if isinstance(node, dict):
        if not node:
            out[path] = {}
        for key, value in node.items():
            out.update(flatten(value, f"{path}.{key}"))
    elif isinstance(node, list):
        if not node:
            out[path] = []
        for i, item in enumerate(node):
            out.update(flatten(item, f"{path}[{i}]"))
    else:
        out[path] = node
    return out


def normalise(path: str) -> str:
    """Collapse list indices so 'shape' comparison ignores how many items were captured."""
    return re.sub(r"\[\d+\]", "[]", path)


def find_artifacts(execution_id: str) -> tuple[Path | None, list[Path]]:
    base = gcapi.ARTIFACTS / "validation"
    direct = base / f"{execution_id}-direct.json"
    jobs = sorted(base.glob(f"{execution_id}-job-*.json"))
    return (direct if direct.is_file() else None), jobs


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path.name} is not valid JSON: {exc}") from exc


def compare(direct: Any, jobs: Any) -> dict:
    d_flat = flatten(direct)
    j_flat = flatten(jobs)

    d_shapes = {normalise(p) for p in d_flat}
    j_shapes = {normalise(p) for p in j_flat}

    missing_shapes = sorted(j_shapes - d_shapes)
    extra_shapes = sorted(d_shapes - j_shapes)

    differing = []
    for path, j_value in j_flat.items():
        if path in d_flat and d_flat[path] != j_value and not VOLATILE.search(path):
            differing.append(
                {
                    "path": path,
                    "direct": d_flat[path],
                    "jobs": j_value,
                    "avaSignificant": bool(AVA_SIGNIFICANT.search(path)),
                }
            )

    return {
        "directLeafCount": len(d_flat),
        "jobsLeafCount": len(j_flat),
        "missingShapes": [
            {"path": p, "avaSignificant": bool(AVA_SIGNIFICANT.search(p))} for p in missing_shapes
        ],
        "extraShapes": extra_shapes,
        "differingValues": differing,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--execution-id", help="locate artifacts written by the other harness scripts")
    ap.add_argument("--direct", help="explicit path to the direct download")
    ap.add_argument("--jobs", help="explicit path to a Jobs artifact")
    args = ap.parse_args()

    if args.direct and args.jobs:
        direct_path, job_paths = Path(args.direct), [Path(args.jobs)]
        execution_id = direct_path.stem
    elif args.execution_id:
        execution_id = args.execution_id
        direct_path, job_paths = find_artifacts(execution_id)
        if not direct_path:
            raise SystemExit(
                f"no direct download found for {execution_id}.\n"
                f"Run: python harness/fetch_direct.py --event <event.json>"
            )
        if not job_paths:
            raise SystemExit(
                f"no Jobs artifacts found for {execution_id}.\n"
                f"Run: python harness/jobs_compare.py --execution-id {execution_id}"
            )
    else:
        raise SystemExit("pass --execution-id, or both --direct and --jobs")

    gcapi.banner(f"VALIDATION 1 - direct vs Jobs equivalence for {execution_id}")

    direct = load_json(direct_path)
    print(f"  direct : {direct_path.name}  ({direct_path.stat().st_size} bytes)")

    report: dict = {"executionId": execution_id, "direct": direct_path.name, "comparisons": []}
    gate_failures: list[str] = []

    for job_path in job_paths:
        jobs = load_json(job_path)
        print(f"\n  jobs   : {job_path.name}  ({job_path.stat().st_size} bytes)")

        result = compare(direct, jobs)
        result["jobsArtifact"] = job_path.name
        print(f"    leaves: direct {result['directLeafCount']}, jobs {result['jobsLeafCount']}")

        significant_missing = [m["path"] for m in result["missingShapes"] if m["avaSignificant"]]
        trivial_missing = [m["path"] for m in result["missingShapes"] if not m["avaSignificant"]]

        if significant_missing:
            print(f"    MISSING from direct, AVA-significant ({len(significant_missing)}):")
            for path in significant_missing[:40]:
                print(f"      {path}")
            if len(significant_missing) > 40:
                print(f"      ... and {len(significant_missing) - 40} more")
            gate_failures.append(job_path.name)
        else:
            print("    No AVA-significant paths missing from the direct download.")

        if trivial_missing:
            print(f"    missing but not AVA-significant: {len(trivial_missing)} (metadata/self-links)")

        significant_diffs = [d for d in result["differingValues"] if d["avaSignificant"]]
        if significant_diffs:
            print(f"    Differing AVA-significant values ({len(significant_diffs)}):")
            for d in significant_diffs[:20]:
                print(f"      {d['path']}")
                print(f"        direct: {str(d['direct'])[:100]}")
                print(f"        jobs  : {str(d['jobs'])[:100]}")

        if result["extraShapes"]:
            print(f"    Present in direct but not in Jobs: {len(result['extraShapes'])}")

        report["comparisons"].append(result)

    # ------------------------------------------------------------------- verdict
    print("\n  === Verdict ===")
    if not gate_failures:
        print("  VALIDATION 1: PASS")
        print("  The direct signed download carries every AVA-significant path found in the")
        print("  Jobs artifacts. EventBridge direct download can be the normal path, with Jobs")
        print("  reserved for expired URIs, failures, backfill and reconciliation repair.")
        report["verdict"] = "PASS"
    else:
        print("  VALIDATION 1: FAIL")
        print(f"  The direct download is missing AVA-significant data present in: {gate_failures}")
        print("  Keep Jobs as the authoritative retrieval path (architecture phase 2), and use")
        print("  EventBridge for executionId discovery only.")
        report["verdict"] = "FAIL"
        report["failingArtifacts"] = gate_failures

    out = gcapi.write_artifact(f"v1-diff-{execution_id}.json", report)
    print(f"\n  Evidence: {out}")
    return 0 if not gate_failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
