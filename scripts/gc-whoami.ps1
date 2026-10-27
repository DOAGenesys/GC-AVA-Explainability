<#
Identifies the Genesys Cloud org behind an MCP config file and reports the
facts needed to wire the Amazon EventBridge integration.

Reads credentials from the MCP config so secrets are never passed on a command line.
#>
[CmdletBinding()]
param(
    [string]$McpConfig = $env:GENESYS_MCP_CONFIG,
    [string]$ServerName = "ava-harness"
)
if (-not $McpConfig) { throw "GENESYS_MCP_CONFIG is not set: point it at the org's mcp.json, or pass -McpConfig" }

$ErrorActionPreference = "Stop"

# AVA_HABITAT names the AWS region Genesys Cloud runs the org in; the Platform API
# host differs per region and cannot be derived without this table.
$HabitatToApiHost = @{
    "prod-use1"  = "api.mypurecloud.com"
    "prod-use2"  = "api.use2.us-gov-pure.cloud"
    "prod-usw2"  = "api.usw2.pure.cloud"
    "prod-cac1"  = "api.cac1.pure.cloud"
    "prod-euw1"  = "api.mypurecloud.ie"
    "prod-euw2"  = "api.euw2.pure.cloud"
    "prod-euc1"  = "api.mypurecloud.de"
    "prod-euc2"  = "api.euc2.pure.cloud"
    "prod-apne1" = "api.mypurecloud.jp"
    "prod-apne2" = "api.apne2.pure.cloud"
    "prod-apne3" = "api.apne3.pure.cloud"
    "prod-aps1"  = "api.aps1.pure.cloud"
    "prod-apse2" = "api.mypurecloud.com.au"
    "prod-sae1"  = "api.sae1.pure.cloud"
    "prod-mec1"  = "api.mec1.pure.cloud"
    "prod-euw1f" = "api.euw1f.pure.cloud"
}

$cfg = Get-Content -Raw -LiteralPath $McpConfig | ConvertFrom-Json
$env_ = $cfg.mcpServers.$ServerName.env
if (-not $env_) { throw "Server '$ServerName' not found in $McpConfig" }

$habitat = $env_.AVA_HABITAT
$apiHost = $HabitatToApiHost[$habitat]
if (-not $apiHost) { throw "Unknown AVA_HABITAT '$habitat'; extend the habitat table." }
$loginHost = $apiHost -replace '^api\.', 'login.'

Write-Host "MCP config : $McpConfig"
Write-Host "Habitat    : $habitat"
Write-Host "API host   : https://$apiHost"
Write-Host "Client ID  : $($env_.GENESYS_CLIENT_ID)"
Write-Host ""

$pair = "$($env_.GENESYS_CLIENT_ID):$($env_.GENESYS_CLIENT_SECRET)"
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))

$token = (Invoke-RestMethod -Method Post -Uri "https://$loginHost/oauth/token" `
    -Headers @{ Authorization = "Basic $basic" } `
    -ContentType "application/x-www-form-urlencoded" `
    -Body "grant_type=client_credentials").access_token

Write-Host "Token      : acquired ($($token.Length) chars)"
Write-Host ""

$auth = @{ Authorization = "Bearer $token" }

$me = Invoke-RestMethod -Uri "https://$apiHost/api/v2/organizations/me" -Headers $auth
Write-Host "=== Organization ==="
Write-Host "Name       : $($me.name)"
Write-Host "Org ID     : $($me.id)"
Write-Host "Short name : $($me.thirdPartyOrgName)"
Write-Host "Domain     : $($me.domain)"
Write-Host "Version    : $($me.version)"
Write-Host "State      : $($me.state)"
Write-Host ""

Write-Host "=== Partner event source name Genesys will create in AWS ==="
Write-Host "aws.partner/genesys.com/cloud/$($me.id)/<eventSourceSuffix>"
