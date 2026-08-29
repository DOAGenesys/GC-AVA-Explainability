<#
Live view of the collection pipeline, for use while running tests on the Genesys side.

Reports, on an interval:
  - new events landing in the discovery log group (with their real detail-type)
  - new manifest rows and their status
  - new Bronze objects, so you can see the downloaded execution history arriving
  - queue depth and DLQ depth

Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION.
#>
[CmdletBinding()]
param(
    [string]$NamePrefix = "ava-explain",
    [string]$Region = $env:AWS_REGION,
    [int]$IntervalSeconds = 10,
    [int]$LookbackMinutes = 15
)

$ErrorActionPreference = "Stop"
if (-not $env:AWS_ACCESS_KEY_ID) { throw "AWS_ACCESS_KEY_ID is not set. Run scripts\load-aws-env.ps1 first." }
if (-not $Region) { throw "Region not set. Pass -Region or set AWS_REGION." }

$py = @"
import sys, time, json, boto3
from datetime import datetime, timezone, timedelta

prefix, region, interval, lookback = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])

logs = boto3.client("logs", region_name=region)
ddb  = boto3.client("dynamodb", region_name=region)
sqs  = boto3.client("sqs", region_name=region)
s3   = boto3.client("s3", region_name=region)
sts  = boto3.client("sts", region_name=region)

account = sts.get_caller_identity()["Account"]
bucket  = "%s-bronze-%s-%s" % (prefix, account, region)
table   = "%s-manifest" % prefix
log_group = "/aws/events/%s/raw" % prefix

def queue_url(name):
    try:
        return sqs.get_queue_url(QueueName=name)["QueueUrl"]
    except Exception:
        return None

q  = queue_url("%s-collector" % prefix)
dq = queue_url("%s-collector-dlq" % prefix)

seen_events, seen_keys, seen_rows = set(), set(), {}
start_ms = int((datetime.now(timezone.utc) - timedelta(minutes=lookback)).timestamp() * 1000)

print("watching  bucket=%s  table=%s  logs=%s" % (bucket, table, log_group))
print("Run a test on the Genesys side; anything that arrives shows up below.")
print("-" * 100)

while True:
    stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")

    # --- events arriving on the partner bus
    try:
        resp = logs.filter_log_events(logGroupName=log_group, startTime=start_ms, limit=200)
        for ev in resp.get("events", []):
            if ev["eventId"] in seen_events:
                continue
            seen_events.add(ev["eventId"])
            try:
                msg = json.loads(ev["message"])
                dt  = msg.get("detail-type", "?")
                det = msg.get("detail", {}) or {}
                ex  = det.get("executionId", "-")
                has_uri = "yes" if det.get("executionHistoryUri") else "NO"
                ttl = det.get("executionHistoryUriTtl", "-")
                trunc = det.get("executionItemsTruncated", "-")
                items = len(det.get("execution") or [])
                print("[%s] EVENT   detail-type=%s" % (stamp, dt))
                print("            executionId=%s  uri=%s  ttl=%ss  truncated=%s  inlineItems=%d"
                      % (ex, has_uri, ttl, trunc, items))
            except Exception:
                print("[%s] EVENT   (unparsed) %s" % (stamp, ev["message"][:200]))
    except logs.exceptions.ResourceNotFoundException:
        print("[%s] log group %s does not exist yet" % (stamp, log_group))
    except Exception as e:
        print("[%s] logs error: %s" % (stamp, e))

    # --- manifest rows
    try:
        for item in ddb.scan(TableName=table, Limit=100).get("Items", []):
            pk = item["pk"]["S"]
            st = item.get("status", {}).get("S", "?")
            if seen_rows.get(pk) == st:
                continue
            seen_rows[pk] = st
            bites = item.get("historyBytes", {}).get("N")
            ms    = item.get("downloadElapsedMs", {}).get("N")
            dupes = item.get("duplicateDeliveries", {}).get("N", "0")
            extra = ""
            if bites: extra += "  %s bytes" % bites
            if ms:    extra += "  in %s ms" % ms
            if dupes not in ("0", None): extra += "  dupes=%s" % dupes
            print("[%s] MANIFEST %-18s %s%s" % (stamp, st, pk, extra))
            reason = item.get("recoveryReason", {}).get("S")
            if reason:
                print("            reason: %s" % reason)
    except Exception as e:
        print("[%s] manifest error: %s" % (stamp, e))

    # --- bronze objects
    try:
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix="bronze/"):
            for obj in page.get("Contents", []):
                if obj["Key"] in seen_keys:
                    continue
                seen_keys.add(obj["Key"])
                print("[%s] S3      %8d  %s" % (stamp, obj["Size"], obj["Key"]))
    except Exception as e:
        print("[%s] s3 error: %s" % (stamp, e))

    # --- queue health
    try:
        depth = dlq_depth = "?"
        if q:
            a = sqs.get_queue_attributes(QueueUrl=q, AttributeNames=["ApproximateNumberOfMessages","ApproximateAgeOfOldestMessage"])["Attributes"]
            depth = "%s (oldest %ss)" % (a.get("ApproximateNumberOfMessages","0"), a.get("ApproximateAgeOfOldestMessage","0"))
        if dq:
            dlq_depth = sqs.get_queue_attributes(QueueUrl=dq, AttributeNames=["ApproximateNumberOfMessages"])["Attributes"].get("ApproximateNumberOfMessages","0")
        if depth not in ("0 (oldest 0s)", "?") or dlq_depth not in ("0", "?"):
            print("[%s] QUEUE   inflight=%s  dlq=%s" % (stamp, depth, dlq_depth))
    except Exception:
        pass

    time.sleep(interval)
"@

$tmp = Join-Path $env:TEMP "watch_events.py"
$py | Set-Content -LiteralPath $tmp -Encoding UTF8
try {
    python $tmp $NamePrefix $Region $IntervalSeconds $LookbackMinutes
} finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}
