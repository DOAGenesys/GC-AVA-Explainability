"""Search the live Genesys OpenAPI definition for a property name and print its enums.

Small tool, but it earns its place: this project has already been wrong three times by
inferring contract details from prose instead of the spec - `expands` versus the `expand` query
parameter, `criteriaKey/values` versus `key/value`, and `executionId` versus `id`. Checking is
cheaper than debugging a 20-minute poll loop that was waiting for a state name that does not
exist.

Usage:
  python harness/spec_grep.py jobState
  python harness/spec_grep.py --definitions ExecutionData
  python harness/spec_grep.py --paths textbots
"""

from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path

import gcapi

# The definition is ~22 MB. Downloading it per question turned a cheap lookup into a slow one,
# which is exactly the friction that led to guessing contracts in the first place.
CACHE = Path(__file__).resolve().parent.parent / "artifacts" / "cache" / "swagger.json"
CACHE_MAX_AGE_S = 24 * 3600


def load_spec(ca_bundle: str | None, refresh: bool = False) -> dict:
    if not refresh and CACHE.is_file() and (time.time() - CACHE.stat().st_mtime) < CACHE_MAX_AGE_S:
        age_h = (time.time() - CACHE.stat().st_mtime) / 3600
        print(f"Using cached definition ({CACHE.stat().st_size / 1e6:.1f} MB, {age_h:.1f}h old)")
        return json.loads(CACHE.read_text(encoding="utf-8"))

    config = gcapi.load_org_config()
    url = f"https://{config.api_host}/api/v2/docs/swagger"
    print(f"Reading {url} ...")
    # Anonymous on purpose: the definition needs no token, and this keeps the lookup usable
    # before OAuth scopes are sorted out on a new org.
    resp = gcapi.request(url, timeout=300, ca_bundle=ca_bundle)
    if not resp.ok:
        raise SystemExit(f"failed: {resp.status} {resp.error}")
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_bytes(resp.body)
    return resp.json()


def show_paths(spec: dict, pattern_text: str) -> int:
    pattern = re.compile(pattern_text, re.I)
    paths = spec.get("paths") or {}
    hits = 0
    for path in sorted(paths):
        if not pattern.search(path):
            continue
        for method, op in sorted(paths[path].items()):
            if method not in ("get", "post", "put", "patch", "delete"):
                continue
            hits += 1
            print(f"  {method.upper():6} {path}")
            if op.get("summary"):
                print(f"         {op['summary']}")
            for param in op.get("parameters") or []:
                ref = (param.get("schema") or {}).get("$ref", "")
                kind = ref.rsplit("/", 1)[-1] if ref else param.get("type", "?")
                required = "required" if param.get("required") else "optional"
                print(f"         - {param.get('name')} ({param.get('in')}, {kind}, {required})")
    print(f"\n  {hits} operation(s) matching '{pattern_text}'")
    return 0


def show_detail(definitions: dict, name: str, depth: int = 0, seen: set | None = None) -> None:
    """Print a definition and the definitions it references, recursively.

    Request bodies here nest three deep (launch request -> flow -> version), and the useful
    detail - which fields are required, which are enums - only lives on the leaves.
    """
    seen = seen if seen is not None else set()
    if name in seen or depth > 4:
        return
    seen.add(name)
    definition = definitions.get(name)
    if definition is None:
        print(f"{'  ' * depth}{name}: NOT FOUND")
        return
    pad = "  " * depth
    print(f"{pad}{name}")
    required = set(definition.get("required") or [])
    for prop, meta in sorted((definition.get("properties") or {}).items()):
        items = meta.get("items") or {}
        ref = meta.get("$ref") or items.get("$ref")
        enum = meta.get("enum") or items.get("enum")
        bits = [meta.get("type", "object")]
        if prop in required:
            bits.append("REQUIRED")
        if enum:
            bits.append(f"enum={enum}")
        print(f"{pad}    {prop}: {' '.join(bits)}")
        if ref:
            show_detail(definitions, ref.rsplit("/", 1)[-1], depth + 3, seen)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("needle", nargs="?", help="property name to search for")
    ap.add_argument("--definitions", help="regex: list definition names that match")
    ap.add_argument("--paths", help="regex: list API paths that match, with their parameters")
    ap.add_argument(
        "--detail", action="append", help="definition name: print it and its references, recursively"
    )
    ap.add_argument("--refresh", action="store_true", help="ignore the cached definition")
    ap.add_argument("--ca-bundle")
    args = ap.parse_args()

    spec = load_spec(args.ca_bundle, refresh=args.refresh)
    definitions = spec.get("definitions") or {}
    print(f"  {len(definitions)} definitions, {len(spec.get('paths') or {})} paths\n")

    if args.paths:
        return show_paths(spec, args.paths)

    if args.detail:
        for name in args.detail:
            show_detail(definitions, name)
            print()
        return 0

    if args.definitions:
        pattern = re.compile(args.definitions, re.I)
        for name in sorted(definitions):
            if pattern.search(name):
                props = (definitions[name].get("properties") or {}).keys()
                print(f"  {name}")
                print(f"    {', '.join(sorted(props))}")
        return 0

    if not args.needle:
        raise SystemExit("pass a property name, or --definitions <regex>, or --paths <regex>")

    hits = 0
    for name, definition in sorted(definitions.items()):
        props = definition.get("properties") or {}
        if args.needle not in props:
            continue
        hits += 1
        meta = props[args.needle]
        enum = meta.get("enum") or (meta.get("items") or {}).get("enum")
        print(f"  {name}.{args.needle}: {meta.get('type', '?')}")
        if enum:
            print(f"    enum = {enum}")
        if meta.get("description"):
            print(f"    {meta['description'][:160]}")
    print(f"\n  {hits} definition(s) carry '{args.needle}'")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
