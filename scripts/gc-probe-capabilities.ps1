<#
Probes, operation by operation, whether the OAuth client can now perform every action the
build and the Section 11 validations require.

This exists because role names are not capability. The client reports "Master Admin", but a
403 on a single endpoint still blocks a whole validation gate, and the only reliable check is
to call the endpoint. Phase 0 recorded 403 on execution-data settings, flow log levels,
Architect flows and flow-instance jobs; this re-establishes the true position.

Read-only. Every probe is a GET, or a POST that is deliberately shaped to be rejected on
validation grounds rather than performing work - see Probe-Post.
#>
[CmdletBinding()]
param(
    [string]$McpConfig = "C:\Users\<user>\cursor\AVA skills MCP Cursor files\<org-folder>\mcp.json",
    [string]$ServerName = "ava-harness",
    [string]$OutFile = ".\artifacts\capability-probe.json"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$HabitatToApiHost = @{
    "prod-use1"  = "api.mypurecloud.com"; "prod-usw2"  = "api.usw2.pure.cloud"
    "prod-cac1"  = "api.cac1.pure.cloud";  "prod-euw1"  = "api.mypurecloud.ie"
    "prod-euw2"  = "api.euw2.pure.cloud";  "prod-euc1"  = "api.mypurecloud.de"
    "prod-euc2"  = "api.euc2.pure.cloud";  "prod-apne1" = "api.mypurecloud.jp"
    "prod-apne2" = "api.apne2.pure.cloud"; "prod-apne3" = "api.apne3.pure.cloud"
    "prod-aps1"  = "api.aps1.pure.cloud";  "prod-apse2" = "api.mypurecloud.com.au"
    "prod-sae1"  = "api.sae1.pure.cloud";  "prod-mec1"  = "api.mec1.pure.cloud"
}

$cfg = (Get-Content -Raw -LiteralPath $McpConfig | ConvertFrom-Json).mcpServers.$ServerName.env
$apiHost = $HabitatToApiHost[$cfg.AVA_HABITAT]
$loginHost = $apiHost -replace '^api\.', 'login.'

$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($cfg.GENESYS_CLIENT_ID):$($cfg.GENESYS_CLIENT_SECRET)"))
$token = (Invoke-RestMethod -Method Post -Uri "https://$loginHost/oauth/token" `
    -Headers @{ Authorization = "Basic $basic" } `
    -ContentType "application/x-www-form-urlencoded" `
    -Body "grant_type=client_credentials").access_token
$auth = @{ Authorization = "Bearer $token" }

$results = [ordered]@{}

function Probe-Get {
    param([string]$Label, [string]$Path, [string]$Gates)

    try {
        $data = Invoke-RestMethod -Uri "https://$apiHost$Path" -Headers $auth
        $note = ""
        if ($null -ne $data.total) { $note = "total=$($data.total)" }
        elseif ($data.entities) { $note = "entities=$(@($data.entities).Count)" }
        Write-Host ("  [ OK  ] {0,-38} {1}" -f $Label, $note) -ForegroundColor Green
        $script:results[$Label] = @{ ok = $true; status = 200; gates = $Gates; note = $note }
        return $data
    } catch {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        $colour = if ($code -eq 403) { "Red" } else { "Yellow" }
        Write-Host ("  [{0,4} ] {1,-38} {2}" -f $code, $Label, $Gates) -ForegroundColor $colour
        $script:results[$Label] = @{ ok = $false; status = $code; gates = $Gates }
        return $null
    }
}

function Probe-Post {
    param([string]$Label, [string]$Path, $Body, [string]$Gates)

    # A 400 here is the desired outcome: it proves authorisation passed and only the payload
    # was rejected, which is exactly what we want to know without creating anything.
    try {
        Invoke-RestMethod -Method Post -Uri "https://$apiHost$Path" -Headers $auth `
            -ContentType "application/json" -Body ($Body | ConvertTo-Json -Depth 5) | Out-Null
        Write-Host ("  [ OK  ] {0,-38} accepted (unexpected)" -f $Label) -ForegroundColor Yellow
        $script:results[$Label] = @{ ok = $true; status = 200; gates = $Gates }
    } catch {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        if ($code -eq 400 -or $code -eq 422) {
            Write-Host ("  [ OK  ] {0,-38} authorised (validation {1})" -f $Label, $code) -ForegroundColor Green
            $script:results[$Label] = @{ ok = $true; status = $code; gates = $Gates; note = "authorised; payload rejected" }
        } else {
            $colour = if ($code -eq 403) { "Red" } else { "Yellow" }
            Write-Host ("  [{0,4} ] {1,-38} {2}" -f $code, $Label, $Gates) -ForegroundColor $colour
            $script:results[$Label] = @{ ok = $false; status = $code; gates = $Gates }
        }
    }
}

Write-Host "=== Capability probe: $apiHost ===" -ForegroundColor Cyan
Write-Host ""

Write-Host "-- Genesys configuration prerequisites (architecture section 3) --"
$exec = Probe-Get "read execution-data settings" "/api/v2/flows/instances/settings/executiondata" "S3.1"
$dflt = Probe-Get "read org default log level" "/api/v2/flows/instances/settings/loglevels/default" "S3.2"
Probe-Get "list per-flow log level overrides" "/api/v2/flows/instances/settings/loglevels" "S3.2" | Out-Null

Write-Host ""
Write-Host "-- Architect flows (test flow, AVA registry) --"
Probe-Get "list Architect flows" "/api/v2/flows?pageSize=1" "V9, Deliverable C" | Out-Null
Probe-Get "list bot flows" "/api/v2/flows?type=BOT&pageSize=5" "V9" | Out-Null
Probe-Get "list digital bot flows" "/api/v2/flows?type=DIGITALBOT&pageSize=5" "V9" | Out-Null

Write-Host ""
Write-Host "-- Flow instance Jobs (the fallback path, validations 1-3) --"
Probe-Get "list flow-instance jobs" "/api/v2/flows/instances/jobs" "V1, V2, V3" | Out-Null
# Empty ids[] is invalid, so a 400 proves authorisation without submitting a real job.
Probe-Post "submit flow-instance job" "/api/v2/flows/instances/jobs" @{ ids = @() } "V1, V2, V3"

Write-Host ""
Write-Host "-- Flow instance query (last-resort forensic path) --"
Probe-Post "query flow instances" "/api/v2/flows/instances/query" @{} "S5.3"

Write-Host ""
Write-Host "-- Integrations (the EventBridge source we must create) --"
Probe-Get "list integrations" "/api/v2/integrations?pageSize=1" "Deliverable A" | Out-Null
Probe-Get "read eventbridge integration type" "/api/v2/integrations/types/amazon-eventbridge-source" "Deliverable A" | Out-Null

Write-Host ""
Write-Host "-- Notifications --"
Probe-Get "list available topics" "/api/v2/notifications/availabletopics?expand=transports&pageSize=500" "V8" | Out-Null

# ------------------------------------------------------------------ actual config values
Write-Host ""
Write-Host "=== Genesys prerequisite state (does anything need changing?) ===" -ForegroundColor Cyan
$storageEnabled = $null
$defaultLevel = $null
if ($exec) {
    $storageEnabled = [bool]$exec.enabled
    Write-Host "  Execution-data storage enabled : $storageEnabled   (modified $($exec.dateModified))"
}
if ($dflt) {
    $defaultLevel = $dflt.logLevelCharacteristics.level
    Write-Host "  Org default log level          : $defaultLevel   (modified $($dflt.dateModified))"
}
if ($storageEnabled -and $defaultLevel -eq "All") {
    Write-Host "  => Section 3 is already satisfied org-wide. No Genesys config change required." -ForegroundColor Green
} elseif ($storageEnabled) {
    Write-Host "  => Storage is on but the default level is '$defaultLevel'. AVA flows need 'All'." -ForegroundColor Yellow
} else {
    Write-Host "  => Storage is OFF. Nothing downstream can work until it is enabled." -ForegroundColor Red
}

# ------------------------------------------------------------------------------ verdict
$blocked = @($results.GetEnumerator() | Where-Object { -not $_.Value.ok })
Write-Host ""
Write-Host "=== Verdict ===" -ForegroundColor Cyan
if ($blocked.Count -eq 0) {
    Write-Host "  All probed operations are authorised." -ForegroundColor Green
} else {
    Write-Host "  $($blocked.Count) operation(s) still blocked:" -ForegroundColor Yellow
    foreach ($b in $blocked) {
        Write-Host ("    {0,4}  {1}  (gates: {2})" -f $b.Value.status, $b.Key, $b.Value.gates)
    }
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
[ordered]@{
    probedAt        = (Get-Date).ToUniversalTime().ToString("o")
    apiHost         = $apiHost
    storageEnabled  = $storageEnabled
    orgDefaultLevel = $defaultLevel
    operations      = $results
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutFile -Encoding UTF8
Write-Host ""
Write-Host "Report written to $OutFile"
