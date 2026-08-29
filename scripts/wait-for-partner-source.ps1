<#
Polls AWS until the Genesys partner event source appears, which happens a few minutes after
the integration is activated. The AWS stack's aws_cloudwatch_event_source data source fails
hard if applied before this, so the two applies must be separated by this wait.

Uses boto3 rather than the AWS CLI, which is not installed on this machine.
Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION.
#>
[CmdletBinding()]
param(
    [string]$OrgId = "<GENESYS_ORG_ID>",
    [string]$Suffix = "do-eventbridge-ava-explain",
    [string]$Region = $env:AWS_REGION,
    [int]$TimeoutSeconds = 900
)

$ErrorActionPreference = "Stop"

if (-not $env:AWS_ACCESS_KEY_ID) {
    throw @"
No AWS credentials in this process. Run this script through the aws skill, which injects them
into the wrapped command only:

  powershell -File `$env:USERPROFILE\.cursor\skills\aws\scripts\aws-exec.ps1 ``
    -Region eu-central-1 -Run "powershell -File .\scripts\wait-for-partner-source.ps1"
"@
}
if (-not $Region) { throw "Region not set. Pass -Region or set AWS_REGION." }

$expected = "aws.partner/genesys.com/cloud/$OrgId/$Suffix"
Write-Host "Waiting for partner event source:"
Write-Host "  $expected"
Write-Host "  region: $Region   timeout: ${TimeoutSeconds}s"
Write-Host ""

$py = @"
import sys, time, boto3
expected, region, timeout = sys.argv[1], sys.argv[2], int(sys.argv[3])
eb = boto3.client("events", region_name=region)
deadline = time.time() + timeout
while True:
    found = None
    paginator = eb.get_paginator("list_event_sources") if eb.can_paginate("list_event_sources") else None
    sources = []
    if paginator:
        for page in paginator.paginate():
            sources.extend(page.get("EventSources", []))
    else:
        sources = eb.list_event_sources().get("EventSources", [])
    for s in sources:
        if s["Name"] == expected:
            found = s
            break
    if found:
        print("FOUND state=%s name=%s" % (found.get("State"), found["Name"]))
        sys.exit(0)
    if time.time() > deadline:
        print("TIMEOUT. Partner sources currently visible:")
        for s in sources:
            print("   - %s  (%s)" % (s["Name"], s.get("State")))
        sys.exit(1)
    print("  not yet... (%d partner sources visible)" % len(sources))
    time.sleep(15)
"@

$tmp = Join-Path $env:TEMP "wait_partner_source.py"
$py | Set-Content -LiteralPath $tmp -Encoding UTF8

# Prefer the aws skill's venv, which is where boto3 is guaranteed to exist on this machine.
$venvPython = "$env:USERPROFILE\.cursor\skills\aws\.venv\Scripts\python.exe"
$python = if (Test-Path -LiteralPath $venvPython) { $venvPython } else { "python" }

& $python $tmp $expected $Region $TimeoutSeconds
$code = $LASTEXITCODE
Remove-Item -LiteralPath $tmp -Force

if ($code -ne 0) {
    Write-Host ""
    Write-Host "The source did not appear. Check, in order:"
    Write-Host "  1. Is the Genesys integration state ENABLED, not DISABLED?"
    Write-Host "  2. Does awsAccountId on the integration match the account these keys belong to?"
    Write-Host "  3. Does awsAccountRegion match -Region?"
    Write-Host "  4. Genesys deactivates the integration if account/region/suffix changed - reactivate it."
    exit 1
}

Write-Host ""
Write-Host "Ready. Next: terraform -chdir=infra\aws apply"
