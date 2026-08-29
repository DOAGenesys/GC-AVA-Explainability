<#
Waits for the first v2.flows.instances.flow event to traverse the pipeline, then prints what
arrived and stops.

The org is shared and busy, so ambient traffic is the trigger: any author running any Architect
flow produces an execution. Nothing here drives Genesys - it only watches.

Emits 'FIRST EVENT' on success so a caller can match on it.

  powershell -File $env:USERPROFILE\.cursor\skills\aws\scripts\aws-exec.ps1 `
    -Region eu-central-1 -Run "powershell -File .\scripts\wait-for-first-event.ps1"
#>
[CmdletBinding()]
param(
    [string]$NamePrefix = "ava-explain",
    [string]$Region = $env:AWS_REGION,
    [int]$TimeoutMinutes = 60,
    [int]$IntervalSeconds = 60
)

$ErrorActionPreference = "Stop"

if (-not $env:AWS_ACCESS_KEY_ID) {
    throw "No AWS credentials in this process. Run it through skills\aws\scripts\aws-exec.ps1."
}
if (-not $Region) { throw "Region not set. Pass -Region or set AWS_REGION." }

$py = @'
import sys, json, time
from collections import Counter
from datetime import datetime, timezone
import boto3
from botocore.exceptions import ClientError

prefix, region, timeout_min, interval = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])

ddb = boto3.client("dynamodb", region_name=region)
s3  = boto3.client("s3", region_name=region)
sts = boto3.client("sts", region_name=region)
account = sts.get_caller_identity()["Account"]
bucket = f"{prefix}-bronze-{account}-{region}"
table = f"{prefix}-manifest"

deadline = time.time() + timeout_min * 60
tick = 0

while True:
    tick += 1
    rows = []
    try:
        for page in ddb.get_paginator("scan").paginate(TableName=table):
            rows.extend(page["Items"])
    except ClientError as e:
        print(f"  scan failed: {e.response['Error']['Code']}", flush=True)

    if rows:
        print(flush=True)
        print("FIRST EVENT - the pipeline has received traffic", flush=True)
        print(f"  manifest rows: {len(rows)}", flush=True)

        statuses = Counter(r.get("status", {}).get("S", "?") for r in rows)
        for k, v in statuses.most_common():
            print(f"    {v:>4}  {k}", flush=True)

        # Show one row in full: this is the first real evidence of the event's field values.
        sample = rows[0]
        print("\n  sample manifest row:", flush=True)
        for key in sorted(sample.keys()):
            val = sample[key].get("S") or sample[key].get("N") or ""
            if key == "pk" or len(str(val)) < 200:
                print(f"    {key:<28} {val}", flush=True)

        for kind in ("envelope", "history-direct", "probe"):
            n = sum(len(p.get("Contents", [])) for p in
                    s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=f"bronze/{kind}/"))
            print(f"  bronze/{kind:<16} {n} object(s)", flush=True)

        sys.exit(0)

    if time.time() > deadline:
        print(f"\nTIMEOUT after {timeout_min} min with no events.", flush=True)
        print("Do not just wait longer. Measured delivery in this org was 2 notifications from", flush=True)
        print("24 deliberately driven executions, so absence of events is the expected case", flush=True)
        print("rather than evidence that no flow ran. See docs/validation-log.md validation 12.", flush=True)
        print("", flush=True)
        print("Instead, create executions on demand and reconcile against a known expected set:", flush=True)
        print("  python harness/drive_bot_flow.py --flow-id <id> --sessions 6", flush=True)
        print("  python harness/reconcile.py --latest-batch     (via the aws skill wrapper)", flush=True)
        sys.exit(1)

    print(f"  [{datetime.now(timezone.utc).strftime('%H:%M:%S')}] tick {tick}: no events yet", flush=True)
    time.sleep(interval)
'@

$tmp = Join-Path $env:TEMP "wait_first_event.py"
$py | Set-Content -LiteralPath $tmp -Encoding UTF8

$venvPython = "$env:USERPROFILE\.cursor\skills\aws\.venv\Scripts\python.exe"
$python = if (Test-Path -LiteralPath $venvPython) { $venvPython } else { "python" }

Write-Host "Watching for the first flow-instance event (timeout ${TimeoutMinutes}m)..."
& $python $tmp $NamePrefix $Region $TimeoutMinutes $IntervalSeconds
$code = $LASTEXITCODE
Remove-Item -LiteralPath $tmp -Force
exit $code
