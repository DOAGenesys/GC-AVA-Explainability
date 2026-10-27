"""Download recovered execution-history artifacts from Bronze for local analysis.

`recover_jobs.py` writes history into S3, which is correct for the pipeline but leaves the
analysis scripts - `ava_coverage.py`, `describe_artifact.py` - with nothing local to read. This
bridges the two so a claim about AVA field completeness can be made against the bytes the
pipeline actually stored, rather than against a separate ad-hoc download.

Run through the aws skill wrapper's venv:
  powershell -File %USERPROFILE%\\.cursor\\skills\\aws\\scripts\\aws-exec.ps1 -Region eu-central-1 ^
    -Run "%USERPROFILE%\\.cursor\\skills\\aws\\.venv\\Scripts\\python.exe harness\\pull_history.py --latest-batch"
"""

from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path

import boto3

import gcapi

DRIVEN = Path(__file__).resolve().parent.parent / "artifacts" / "driven"
OUT = Path(__file__).resolve().parent.parent / "artifacts" / "history"


def wanted_ids(args: argparse.Namespace) -> list[str]:
    if args.execution_id:
        return list(args.execution_id)
    batches = sorted(glob.glob(str(DRIVEN / "botflow-batch-*.json")))
    if not batches:
        raise SystemExit("no batch artifacts; pass --execution-id or run drive_bot_flow.py")
    chosen = batches if args.all_batches else batches[-1:]
    ids: list[str] = []
    for path in chosen:
        ids.extend(json.loads(Path(path).read_text(encoding="utf-8")).get("sessionIds") or [])
    return sorted(set(ids))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bucket", help="defaults to $BRONZE_BUCKET, else derived from the caller's account")
    ap.add_argument("--prefix", default="bronze/history-jobs/")
    ap.add_argument("--execution-id", action="append")
    ap.add_argument("--latest-batch", action="store_true")
    ap.add_argument("--all-batches", action="store_true")
    ap.add_argument("--all", action="store_true", help="pull every object under the prefix")
    ap.add_argument(
        "--out",
        default=str(OUT),
        help="target directory; set it when pulling a prefix other than history-jobs so that "
        "envelopes and history artifacts do not overwrite each other (both are keyed by "
        "executionId, so they collide by default)",
    )
    args = ap.parse_args()
    args.bucket = gcapi.bronze_bucket(args.bucket)

    s3 = boto3.client("s3")
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    keys: list[str] = []
    for page in s3.get_paginator("list_objects_v2").paginate(
        Bucket=args.bucket, Prefix=args.prefix
    ):
        for obj in page.get("Contents", []):
            keys.append(obj["Key"])

    if args.all:
        selected = keys
    else:
        ids = set(wanted_ids(args))
        selected = [k for k in keys if Path(k).stem in ids]

    gcapi.banner(f"Pulling {len(selected)} of {len(keys)} history artifact(s)")
    for key in selected:
        body = s3.get_object(Bucket=args.bucket, Key=key)["Body"].read()
        target = out_dir / f"{Path(key).stem}.json"
        target.write_bytes(body)
        print(f"  {len(body):>7} bytes  {target.name}")

    print(f"\n  -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
