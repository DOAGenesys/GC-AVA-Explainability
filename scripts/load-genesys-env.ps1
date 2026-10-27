<#
Exports the Genesys Cloud Terraform provider's expected environment variables from the
MCP config, so credentials are never written into tfvars, state or shell history.

Dot-source it:  . .\scripts\load-genesys-env.ps1
#>
[CmdletBinding()]
param(
    [string]$McpConfig = $env:GENESYS_MCP_CONFIG,
    [string]$ServerName = "ava-harness"
)
if (-not $McpConfig) { throw "GENESYS_MCP_CONFIG is not set: point it at the org's mcp.json, or pass -McpConfig" }

$ErrorActionPreference = "Stop"

# The provider wants its own region identifiers, which differ from the habitat names.
$HabitatToTfRegion = @{
    "prod-use1"  = "us-east-1";      "prod-usw2"  = "us-west-2"
    "prod-cac1"  = "ca-central-1";   "prod-euw1"  = "eu-west-1"
    "prod-euw2"  = "eu-west-2";      "prod-euc1"  = "eu-central-1"
    "prod-euc2"  = "eu-central-2";   "prod-apne1" = "ap-northeast-1"
    "prod-apne2" = "ap-northeast-2"; "prod-apne3" = "ap-northeast-3"
    "prod-aps1"  = "ap-south-1";     "prod-apse2" = "ap-southeast-2"
    "prod-sae1"  = "sa-east-1";      "prod-mec1"  = "me-central-1"
}

$cfg = (Get-Content -Raw -LiteralPath $McpConfig | ConvertFrom-Json).mcpServers.$ServerName.env
$region = $HabitatToTfRegion[$cfg.AVA_HABITAT]
if (-not $region) { throw "Unknown habitat '$($cfg.AVA_HABITAT)'." }

$env:GENESYSCLOUD_OAUTHCLIENT_ID     = $cfg.GENESYS_CLIENT_ID
$env:GENESYSCLOUD_OAUTHCLIENT_SECRET = $cfg.GENESYS_CLIENT_SECRET
$env:GENESYSCLOUD_REGION             = $region

Write-Host "Genesys provider env set:"
Write-Host "  GENESYSCLOUD_REGION         = $region  (habitat $($cfg.AVA_HABITAT))"
Write-Host "  GENESYSCLOUD_OAUTHCLIENT_ID = $($cfg.GENESYS_CLIENT_ID)"
Write-Host "  GENESYSCLOUD_OAUTHCLIENT_SECRET = <set, $($cfg.GENESYS_CLIENT_SECRET.Length) chars>"
