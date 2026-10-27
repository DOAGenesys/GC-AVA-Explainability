<#
One-shot snapshot of the collection pipeline: what has arrived, what was archived, and what is
stuck. Complements watch-events.ps1, which follows the stream; this answers "where do we stand"
in a single pass.

Reports, in the order data flows:
  partner event source state -> raw event log -> SQS depth -> manifest status counts ->
  Bronze object counts -> Lambda errors -> DLQ

Run through the aws skill so credentials stay out of this shell:

  powershell -File $env:USERPROFILE\.cursor\skills\aws\scripts\aws-exec.ps1 `
    -Region eu-central-1 -Run "powershell -File .\scripts\pipeline-status.ps1"
#>
[CmdletBinding()]
param(
    [string]$NamePrefix = "ava-explain",
    [string]$OrgId = $env:GENESYS_ORG_ID,
    [string]$Suffix = "do-eventbridge-ava-explain",
    [string]$Region = $env:AWS_REGION,
    [int]$LookbackMinutes = 60
)
if (-not $OrgId) { throw "GENESYS_ORG_ID is not set: export the Genesys org id, or pass -OrgId" }

$ErrorActionPreference = "Stop"

if (-not $env:AWS_ACCESS_KEY_ID) {
    throw "No AWS credentials in this process. Run it through skills\aws\scripts\aws-exec.ps1."
}
if (-not $Region) { throw "Region not set. Pass -Region or set AWS_REGION." }

$py = @'
import sys, json, time
from collections import Counter
from datetime import datetime, timedelta, timezone
import boto3
from botocore.exceptions import ClientError

prefix, org_id, suffix, region, lookback = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
bus = f"aws.partner/genesys.com/cloud/{org_id}/{suffix}"

eb   = boto3.client("events",   region_name=region)
logs = boto3.client("logs",     region_name=region)
sqs  = boto3.client("sqs",      region_name=region)
ddb  = boto3.client("dynamodb", region_name=region)
s3   = boto3.client("s3",       region_name=region)
cw   = boto3.client("cloudwatch", region_name=region)
sts  = boto3.client("sts",      region_name=region)

account = sts.get_caller_identity()["Account"]
bucket = f"{prefix}-bronze-{account}-{region}"

def head(t):
    print()
    print(f"-- {t}")

# 1. partner source
head("Partner event source")
try:
    src = eb.describe_event_source(Name=bus)
    print(f"   state    : {src.get('State')}")
    print(f"   created  : {src.get('CreationTime')}")
    exp = src.get("ExpirationTime")
    if exp:
        print(f"   expires  : {exp}   <- unassociated sources expire; associating a bus clears this")
except ClientError as e:
    print(f"   ERROR: {e.response['Error']['Code']}")

try:
    b = eb.describe_event_bus(Name=bus)
    print(f"   bus      : present ({b.get('Name')})")
except ClientError as e:
    print(f"   bus      : MISSING ({e.response['Error']['Code']})")

# 2. raw discovery log
head(f"Raw event log (last {lookback} min)")
lg = f"/aws/events/{prefix}/raw"
start = int((datetime.now(timezone.utc) - timedelta(minutes=lookback)).timestamp() * 1000)
try:
    streams = logs.describe_log_streams(logGroupName=lg, orderBy="LastEventTime", descending=True, limit=5)
    total = 0
    detail_types = Counter()
    for st in streams.get("logStreams", []):
        ev = logs.get_log_events(logGroupName=lg, logStreamName=st["logStreamName"],
                                 startTime=start, limit=200, startFromHead=False)
        for e in ev.get("events", []):
            total += 1
            try:
                detail_types[json.loads(e["message"]).get("detail-type", "?")] += 1
            except Exception:
                pass
    print(f"   events seen : {total}  (across {len(streams.get('logStreams', []))} newest streams)")
    if detail_types:
        print("   detail-type values observed:")
        for k, v in detail_types.most_common():
            print(f"     {v:>5}  {k}")
    elif total == 0:
        print("   No events yet. Either no flow has run in the org since deployment,")
        print("   or delivery is not reaching the bus.")
except ClientError as e:
    print(f"   {e.response['Error']['Code']}: log group not created until the first event arrives")

# 3. queues
head("Queues")
for name in (f"{prefix}-collector", f"{prefix}-collector-dlq"):
    try:
        url = sqs.get_queue_url(QueueName=name)["QueueUrl"]
        # ApproximateAgeOfOldestMessage is a CloudWatch metric, not a queue attribute, so
        # asking SQS for it fails the whole call with InvalidAttributeName.
        a = sqs.get_queue_attributes(QueueUrl=url, AttributeNames=[
            "ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible",
            "ApproximateNumberOfMessagesDelayed"])["Attributes"]
        age = cw.get_metric_statistics(
            Namespace="AWS/SQS", MetricName="ApproximateAgeOfOldestMessage",
            Dimensions=[{"Name": "QueueName", "Value": name}],
            StartTime=datetime.now(timezone.utc) - timedelta(minutes=15),
            EndTime=datetime.now(timezone.utc), Period=300, Statistics=["Maximum"])
        points = age.get("Datapoints", [])
        oldest = f"{int(max(p['Maximum'] for p in points))}s" if points else "-"
        print(f"   {name:<32} visible={a.get('ApproximateNumberOfMessages')} "
              f"inflight={a.get('ApproximateNumberOfMessagesNotVisible')} "
              f"oldestAge={oldest}")
    except ClientError as e:
        print(f"   {name}: {e.response['Error']['Code']}")

# 4. manifest
head("Manifest status counts")
table = f"{prefix}-manifest"
try:
    counts = Counter()
    dupes = 0
    truncated = 0
    scanned = 0
    paginator = ddb.get_paginator("scan")
    for page in paginator.paginate(TableName=table,
            ProjectionExpression="#s,duplicateDeliveries,executionItemsTruncated",
            ExpressionAttributeNames={"#s": "status"}):
        for item in page["Items"]:
            scanned += 1
            counts[item.get("status", {}).get("S", "?")] += 1
            d = item.get("duplicateDeliveries", {}).get("N")
            if d and int(d) > 0:
                dupes += 1
            if item.get("executionItemsTruncated", {}).get("S") == "True":
                truncated += 1
    print(f"   rows: {scanned}")
    for k, v in counts.most_common():
        print(f"     {v:>5}  {k}")
    if scanned:
        print(f"   executions with duplicate delivery : {dupes}   <- validation 7 evidence")
        print(f"   events with executionItemsTruncated: {truncated}")
except ClientError as e:
    print(f"   {e.response['Error']['Code']}")

# 5. bronze
head(f"Bronze objects (s3://{bucket})")
try:
    # history-jobs is where recover_jobs.py writes. Since no event has ever carried an
    # executionHistoryUri, it is the prefix that actually accumulates execution history, and
    # omitting it made the pipeline look like it was storing envelopes and nothing else.
    for kind in ("envelope", "history-direct", "history-jobs", "probe"):
        n = 0
        size = 0
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=f"bronze/{kind}/"):
            for o in page.get("Contents", []):
                n += 1
                size += o["Size"]
        print(f"   {kind:<16} {n:>6} objects  {size/1048576:.2f} MB")
except ClientError as e:
    print(f"   {e.response['Error']['Code']}")

# 6. lambda health
head(f"Collector Lambda metrics (last {lookback} min)")
end = datetime.now(timezone.utc)
begin = end - timedelta(minutes=lookback)
for metric in ("Invocations", "Errors", "Throttles"):
    r = cw.get_metric_statistics(Namespace="AWS/Lambda", MetricName=metric,
        Dimensions=[{"Name": "FunctionName", "Value": f"{prefix}-collector"}],
        StartTime=begin, EndTime=end, Period=max(60, lookback*60), Statistics=["Sum"])
    total = sum(d["Sum"] for d in r.get("Datapoints", []))
    print(f"   {metric:<14} {int(total)}")

print()
print("=" * 70)
'@

$tmp = Join-Path $env:TEMP "pipeline_status.py"
$py | Set-Content -LiteralPath $tmp -Encoding UTF8

$venvPython = "$env:USERPROFILE\.cursor\skills\aws\.venv\Scripts\python.exe"
$python = if (Test-Path -LiteralPath $venvPython) { $venvPython } else { "python" }

Write-Host "=== Pipeline status ($Region) ===" -ForegroundColor Cyan
& $python $tmp $NamePrefix $OrgId $Suffix $Region $LookbackMinutes
$code = $LASTEXITCODE
Remove-Item -LiteralPath $tmp -Force
exit $code
