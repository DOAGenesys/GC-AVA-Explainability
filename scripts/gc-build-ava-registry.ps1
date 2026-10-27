<#
Builds the registry of AVA-containing Architect flows, which is the answer to Validation 9.

Why this matters: topic subscription is org-wide and `{id}` is not parameterised, so every
flow execution in the org arrives at our AWS account. Deciding whether to *download* an
execution history costs nothing if we already know which flowIds can contain an AVA. Without
that, the only alternatives are to download every bot-flow history or to inspect inline
execution items that the Phase 0 probe proved carry no tool detail.

The cheap reliable filter turns out to be published on the flow object itself:

  virtualAgentEnabled        - flow uses a virtual agent
  agenticVirtualAgentEnabled - flow uses an AVA

Both are returned by GET /api/v2/flows with no expand, so one paged read of flow metadata
replaces any per-execution inspection. The output feeds the EventBridge rule's flowId filter
and the collector's download decision.

Read-only.
#>
[CmdletBinding()]
param(
    [string]$McpConfig = $env:GENESYS_MCP_CONFIG,
    [string]$ServerName = "ava-harness",
    [string]$OutFile = ".\artifacts\ava-flow-registry.json"
)
if (-not $McpConfig) { throw "GENESYS_MCP_CONFIG is not set: point it at the org's mcp.json, or pass -McpConfig" }

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

Write-Host "=== Enumerating Architect flows in $apiHost ===" -ForegroundColor Cyan

$flows = @()
$page = 1
do {
    $resp = Invoke-RestMethod -Headers $auth `
        -Uri "https://$apiHost/api/v2/flows?pageSize=200&pageNumber=$page"
    $flows += $resp.entities
    Write-Host ("  page {0}/{1}  ({2} flows so far)" -f $page, $resp.pageCount, $flows.Count)
    $page++
    # Courtesy pacing. This is a shared production org and there is no hurry.
    Start-Sleep -Milliseconds 250
} while ($page -le $resp.pageCount)

Write-Host ""
Write-Host "Total flows: $($flows.Count)"

# The flags are absent rather than false on flows that never had them, so coerce explicitly.
function Flag($flow, [string]$name) {
    $v = $flow.PSObject.Properties[$name]
    return ($null -ne $v -and [bool]$v.Value)
}

$ava = @($flows | Where-Object { Flag $_ "agenticVirtualAgentEnabled" })
$va  = @($flows | Where-Object { (Flag $_ "virtualAgentEnabled") -and -not (Flag $_ "agenticVirtualAgentEnabled") })

Write-Host ""
Write-Host "=== Validation 9: how many flows can actually contain an AVA? ===" -ForegroundColor Cyan
Write-Host "  agenticVirtualAgentEnabled = true : $($ava.Count)" -ForegroundColor Green
Write-Host "  virtualAgentEnabled only          : $($va.Count)"
Write-Host "  neither                           : $($flows.Count - $ava.Count - $va.Count)"

Write-Host ""
Write-Host "  By flow type:"
$flows | Group-Object type | Sort-Object Count -Descending | ForEach-Object {
    $inGroup = @($_.Group | Where-Object { Flag $_ "agenticVirtualAgentEnabled" })
    Write-Host ("    {0,-14} {1,4} flows, {2,4} AVA-enabled" -f $_.Name, $_.Count, $inGroup.Count)
}

# The selectivity figure is the architectural payoff: it is the fraction of arriving events
# whose execution history is worth downloading at all.
$botLike = @($flows | Where-Object { $_.type -in @("BOT", "DIGITALBOT") })
if ($botLike.Count -gt 0) {
    $pct = [math]::Round(100.0 * $ava.Count / $botLike.Count, 1)
    Write-Host ""
    Write-Host "  Of $($botLike.Count) BOT/DIGITALBOT flows, $($ava.Count) ($pct%) are AVA-enabled."
    Write-Host "  Filtering on flowId therefore avoids downloading the other $(100 - $pct)%."
}

Write-Host ""
Write-Host "=== AVA-enabled flows ===" -ForegroundColor Cyan
$ava | Sort-Object type, name | ForEach-Object {
    $state = if ($_.active) { "active " } else { "inactive" }
    Write-Host ("  {0,-12} {1} {2}" -f $_.type, $state, $_.name)
}

$registry = [ordered]@{
    builtAt   = (Get-Date).ToUniversalTime().ToString("o")
    apiHost   = $apiHost
    orgId     = $cfg.GENESYS_ORG_ID
    totals    = [ordered]@{
        allFlows          = $flows.Count
        botLikeFlows      = $botLike.Count
        avaEnabled        = $ava.Count
        virtualAgentOnly  = $va.Count
    }
    # Consumed by the EventBridge rule's flowId filter and by the collector's download gate.
    avaFlowIds = @($ava | ForEach-Object { $_.id })
    avaFlows   = @($ava | ForEach-Object {
        [ordered]@{
            id     = $_.id
            name   = $_.name
            type   = $_.type
            active = [bool]$_.active
        }
    })
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
$registry | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutFile -Encoding UTF8
Write-Host ""
Write-Host "Registry written to $OutFile"
Write-Host "  $($ava.Count) flowIds available for the EventBridge rule filter."
