<#
Second-pass probe. Resolves two things the first pass could not:
  A. The real field name that marks a notification topic as EventBridge-eligible.
  B. The configuration of the EventBridge integrations already present in the org.
Also enumerates which of the required permissions this OAuth client actually holds,
by probing each endpoint the build depends on.

Read-only.
#>
[CmdletBinding()]
param(
    [string]$McpConfig = "C:\Users\<user>\cursor\AVA skills MCP Cursor files\<org-folder>\mcp.json",
    [string]$ServerName = "ava-harness"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$cfg = (Get-Content -Raw -LiteralPath $McpConfig | ConvertFrom-Json).mcpServers.$ServerName.env
$apiHost = "api.mypurecloud.de"
$loginHost = "login.mypurecloud.de"

$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($cfg.GENESYS_CLIENT_ID):$($cfg.GENESYS_CLIENT_SECRET)"))
$token = (Invoke-RestMethod -Method Post -Uri "https://$loginHost/oauth/token" `
    -Headers @{ Authorization = "Basic $basic" } `
    -ContentType "application/x-www-form-urlencoded" `
    -Body "grant_type=client_credentials").access_token
$auth = @{ Authorization = "Bearer $token" }

function Try-Api([string]$Method, [string]$Path) {
    try {
        return @{ ok = $true; data = (Invoke-RestMethod -Method $Method -Uri "https://$apiHost$Path" -Headers $auth) }
    } catch {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { -1 }
        return @{ ok = $false; status = $code }
    }
}

New-Item -ItemType Directory -Force -Path ".\artifacts" | Out-Null

# ============ A. what does a topic entity actually look like? ============
Write-Host "=== A. Raw shape of a notification topic entity ==="
$topics = Try-Api GET "/api/v2/notifications/availabletopics?expand=schema&pageSize=500"
$all = $topics.data.entities
$flowTopic = $all | Where-Object { $_.id -eq "v2.flows.instances.flow.{id}" }

Write-Host "  Property names present on the flow topic entity:"
$flowTopic.PSObject.Properties.Name | ForEach-Object { Write-Host "    - $_" }
Write-Host ""

Write-Host "  Flow topic entity (schema stripped for readability):"
$copy = $flowTopic | Select-Object -Property * -ExcludeProperty schema
$copy | ConvertTo-Json -Depth 10 | Write-Host
Write-Host ""

# Whatever the eligibility field is called, count it across the org.
foreach ($candidate in @("transports", "publicApiTemplateUriPaths", "visibility", "enforced", "schemaVersion")) {
    $vals = $all | ForEach-Object { $_.$candidate } | Where-Object { $_ } | Select-Object -Unique
    Write-Host "  Distinct values of '$candidate' across 242 topics: $((@($vals) | ForEach-Object { $_ -join '|' }) -join ' ; ')"
}
Write-Host ""

$all | Select-Object -Property * -ExcludeProperty schema |
    ConvertTo-Json -Depth 10 | Set-Content ".\artifacts\all-topics-no-schema.json"
Write-Host "  All 242 topic entities (no schema) -> artifacts\all-topics-no-schema.json"
Write-Host ""

# ============ B. existing EventBridge integrations ============
Write-Host "=== B. Existing EventBridge integrations ==="
foreach ($id in @("189d7bf2-96f8-5cce-8514-b4800f9492ab", "99b74675-75d1-5c49-bcb8-23b1c86f039e")) {
    Write-Host "  --- integration $id ---"
    $i = Try-Api GET "/api/v2/integrations/$id"
    if ($i.ok) {
        Write-Host "  name          : $($i.data.name)"
        Write-Host "  intendedState : $($i.data.intendedState)"
    }
    # Config properties live on a separate sub-resource.
    $c = Try-Api GET "/api/v2/integrations/$id/config/current"
    if ($c.ok) {
        Write-Host "  properties:"
        $c.data.properties | ConvertTo-Json -Depth 10 | Write-Host
        Write-Host "  notes: $($c.data.notes)"
        $c.data | ConvertTo-Json -Depth 10 | Set-Content ".\artifacts\integration-$id-config.json"
    } else {
        Write-Host "  config unreadable (status $($c.status)) - needs integrations:integration:view on config"
    }
    Write-Host ""
}

# ============ C. permission reality check, endpoint by endpoint ============
Write-Host "=== C. Which required operations can this OAuth client perform? ==="
$checks = @(
    @{ Label = "read org";                       M = "GET"; P = "/api/v2/organizations/me" }
    @{ Label = "list notification topics";       M = "GET"; P = "/api/v2/notifications/availabletopics?pageSize=1" }
    @{ Label = "list integrations";              M = "GET"; P = "/api/v2/integrations?pageSize=1" }
    @{ Label = "read integration type";          M = "GET"; P = "/api/v2/integrations/types/amazon-eventbridge-source" }
    @{ Label = "read eventbridge config schema"; M = "GET"; P = "/api/v2/integrations/types/amazon-eventbridge-source/configschemas/properties" }
    @{ Label = "read execdata settings";         M = "GET"; P = "/api/v2/flows/instances/settings/executiondata" }
    @{ Label = "read default log level";         M = "GET"; P = "/api/v2/flows/instances/settings/loglevels/default" }
    @{ Label = "read per-flow log levels";       M = "GET"; P = "/api/v2/flows/instances/settings/loglevels?pageSize=1" }
    @{ Label = "list architect flows";           M = "GET"; P = "/api/v2/flows?pageSize=1" }
    @{ Label = "list flow instance jobs";        M = "GET"; P = "/api/v2/flows/instances/jobs?pageSize=1" }
    @{ Label = "read oauth client";              M = "GET"; P = "/api/v2/oauth/clients/$($cfg.GENESYS_CLIENT_ID)" }
    @{ Label = "list data actions";              M = "GET"; P = "/api/v2/integrations/actions?pageSize=1" }
)
$permReport = @()
foreach ($c in $checks) {
    $r = Try-Api $c.M $c.P
    $mark = if ($r.ok) { "OK  " } else { "$($r.status)" }
    Write-Host ("  [{0}] {1}" -f $mark.PadRight(4), $c.Label)
    $permReport += [ordered]@{ operation = $c.Label; path = $c.P; ok = $r.ok; status = $r.status }
}
$permReport | ConvertTo-Json -Depth 5 | Set-Content ".\artifacts\permission-probe.json"
Write-Host ""
Write-Host "Permission probe -> artifacts\permission-probe.json"

# ============ D. the eventbridge config schema, so Terraform props are exact ============
Write-Host ""
Write-Host "=== D. amazon-eventbridge-source property schema ==="
$s = Try-Api GET "/api/v2/integrations/types/amazon-eventbridge-source/configschemas/properties"
if ($s.ok) {
    $s.data | ConvertTo-Json -Depth 15 | Write-Host
    $s.data | ConvertTo-Json -Depth 15 | Set-Content ".\artifacts\eventbridge-config-schema.json"
} else {
    Write-Host "  unreadable (status $($s.status))"
}
