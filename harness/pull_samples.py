r"""Pull captured notification envelopes out of the Bronze bucket into artifacts/samples/.

The other harness scripts work on local event JSON files. This is what puts them there.

Signed URIs expire, so ordering matters: this lists newest-first and reports the age of each
envelope alongside its TTL, making it obvious which samples are still fetchable and which are
only useful as expired-URI evidence.

Requires AWS credentials, so run it through the aws skill rather than exporting keys:

  powershell -File $env:USERPROFILE\.cursor\skills\aws\scripts\aws-exec.ps1 `
    -Run "python harness\pull_samples.py --bucket <bronze-bucket> --limit 20"
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import gcapi

SAMPLES = gcapi.ARTIFACTS / "samples"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bucket", required=True, help="Bronze bucket name (terraform output bronze_bucket)")
    ap.add_argument("--prefix", default="bronze/envelope/")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--region")
    args = ap.parse_args()

    try:
        import boto3
    except ImportError:
        raise SystemExit(
            "boto3 is required. Run this through the aws skill's wrapper, which uses its venv:\n"
            r"  powershell -File %USERPROFILE%\.cursor\skills\aws\scripts\aws-exec.ps1 -Run "
            '"python harness\\pull_samples.py --bucket <name>"'
        ) from None

    s3 = boto3.client("s3", region_name=args.region)

    gcapi.banner(f"Pulling envelopes from s3://{args.bucket}/{args.prefix}")

    objects: list[dict] = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=args.bucket, Prefix=args.prefix):
        objects.extend(page.get("Contents", []))

    if not objects:
        print("  No envelopes found.")
        print("  Either no events have arrived yet, or the collector is not writing.")
        print("  Check: aws logs tail /aws/lambda/ava-explain-collector --follow")
        return 1

    objects.sort(key=lambda o: o["LastModified"], reverse=True)
    selected = objects[: args.limit]
    print(f"  {len(objects)} envelope(s) present; taking the {len(selected)} newest")

    SAMPLES.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    written = 0
    still_valid = 0

    for obj in selected:
        body = s3.get_object(Bucket=args.bucket, Key=obj["Key"])["Body"].read()
        try:
            envelope = json.loads(body)
        except json.JSONDecodeError:
            print(f"  skipping unparseable {obj['Key']}")
            continue

        detail = envelope.get("detail", envelope)
        execution_id = detail.get("executionId") or Path(obj["Key"]).stem
        out = SAMPLES / f"{execution_id}.json"
        out.write_bytes(body)
        written += 1

        ttl = detail.get("executionHistoryUriTtl")
        age = (now - obj["LastModified"].astimezone(timezone.utc)).total_seconds()
        if isinstance(ttl, (int, float)):
            remaining = ttl - age
            state = f"{remaining:+.0f}s of TTL left" if remaining > 0 else "EXPIRED"
            if remaining > 0:
                still_valid += 1
        else:
            state = "no TTL recorded"

        print(f"    {execution_id}  age {age:>6.0f}s  ttl {ttl}  {state}")

    print(f"\n  {written} sample(s) written to {SAMPLES}")
    print(f"  {still_valid} still within TTL and therefore downloadable")

    if still_valid == 0:
        print("\n  All samples are past TTL. They remain useful for validation 5 expiry")
        print("  evidence and for Jobs recovery (validation 3), but fetch_direct.py will fail.")
    else:
        print("\n  Next:")
        print("    python harness/fetch_direct.py --event artifacts/samples/<id>.json")
        print("    python harness/jobs_compare.py --event artifacts/samples/<id>.json")
        print("    python harness/semantic_diff.py --execution-id <id>")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
