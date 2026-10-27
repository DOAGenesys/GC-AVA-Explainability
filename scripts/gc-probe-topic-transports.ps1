<#
The availabletopics list returned only 'id' and 'schema', so the first probe's
"EventBridge transport" check was a false negative. This tries the documented
expand values to find where transport eligibility is actually exposed.

Read-only.
#>
[CmdletBinding()]
param(
    [string]$McpConfig = $env:GENESYS_MCP_CONFIG,
    [string]$ServerName = "ava-harness"
)
if (-not $McpConfig) { throw "GENESYS_MCP_CONFIG is not set: point it at the org's mcp.json, or pass -McpConfig" }

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$cfg = (Get-Content -Raw -LiteralPath $McpConfig | ConvertFrom-Json).mcpServers.$ServerName.env
$apiHost = "api.mypurecloud.de"

$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($cfg.GENESYS_CLIENT_ID):$($cfg.GENESYS_CLIENT_SECRET)"))
$token = (Invoke-RestMethod -Method Post -Uri "https://login.mypurecloud.de/oauth/token" `
    -Headers @{ Authorization = "Basic $basic" } `
    -ContentType "application/x-www-form-urlencoded" `
    -Body "grant_type=client_credentials").access_token
$auth = @{ Authorization = "Bearer $token" }

$TARGET = "v2.flows.instances.flow.{id}"

foreach ($expand in @("", "transports", "schema,transports", "description,requiresPermissions,transports", "permissions,transports,visibility,enforced,schemaVersion,publicApiTemplateUriPaths")) {
    $q = if ($expand) { "?expand=$expand&pageSize=500" } else { "?pageSize=500" }
    Write-Host "--- expand='$expand' ---"
    try {
        $r = Invoke-RestMethod -Uri "https://$apiHost/api/v2/notifications/availabletopics$q" -Headers $auth
        $t = $r.entities | Where-Object { $_.id -eq $TARGET }
        $props = @($t.PSObject.Properties.Name)
        Write-Host "  fields on target topic: $($props -join ', ')"
        if ($props -contains "transports") {
            Write-Host "  transports = $(@($t.transports) -join ', ')"
            $ebCount = @($r.entities | Where-Object { @($_.transports) -contains 'EventBridge' }).Count
            Write-Host "  topics org-wide with EventBridge transport: $ebCount / $(@($r.entities).Count)"
        }
    } catch {
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { -1 }
        Write-Host "  failed (status $code)"
    }
    Write-Host ""
}

# Confirm the four topics of interest are all present by id, regardless of transport metadata.
Write-Host "--- presence of architecture-relevant topics ---"
$r = Invoke-RestMethod -Uri "https://$apiHost/api/v2/notifications/availabletopics?pageSize=500" -Headers $auth
$ids = @($r.entities.id)
foreach ($t in @("v2.flows.instances.flow.{id}",
                 "v2.detail.events.conversation.{id}.flow.end",
                 "v2.detail.events.conversation.{id}.flow.start",
                 "v2.detail.events.conversation.{id}.flow.outcome",
                 "v2.bot.conversation.{id}.conversations.summaries")) {
    $present = $ids -contains $t
    Write-Host ("  [{0}] {1}" -f $(if ($present) { "present" } else { "MISSING" }), $t)
}
Write-Host ""
Write-Host "Total topics visible to this client: $(@($ids).Count)"
