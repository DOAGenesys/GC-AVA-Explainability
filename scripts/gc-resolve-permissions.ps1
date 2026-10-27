<#
Resolves the exact permission strings and their Admin-UI labels for the domains this
build touches, straight from the target org's own permission catalogue. Avoids relying
on documentation that may lag the org's actual permission names.

Read-only.
#>
[CmdletBinding()]
param(
    [string]$McpConfig = $env:GENESYS_MCP_CONFIG,
    [string]$ServerName = "ava-harness",
    [string[]]$Domains = @("architect", "integrations", "settings")
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

New-Item -ItemType Directory -Force -Path ".\artifacts" | Out-Null

# Entities we care about, per domain.
$wanted = @{
    architect    = @("flow", "flowInstance", "flowInstanceExecutionData", "flowLogLevel", "flowDefaultLogLevel")
    integrations = @("integration", "action")
    settings     = @("*")
}

$rows = @()
foreach ($domain in $Domains) {
    Write-Host "=== domain: $domain ==="
    $page = 1
    $entities = @()
    do {
        try {
            $r = Invoke-RestMethod -Uri "https://$apiHost/api/v2/authorization/permissions?pageSize=500&pageNumber=$page&query=$domain" -Headers $auth
        } catch {
            $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { -1 }
            Write-Host "  permission catalogue unreadable (status $code) - client lacks authorization:grant:view"
            $r = $null
            break
        }
        $entities += $r.entities
        $page++
    } while ($r -and $r.entities.Count -gt 0 -and $page -le ($r.pageCount))

    if (-not $entities) { Write-Host ""; continue }

    $dom = $entities | Where-Object { $_.domain -eq $domain }
    if (-not $dom) { $dom = $entities }

    foreach ($d in $dom) {
        foreach ($cat in $d.permissionMap.PSObject.Properties) {
            $entityName = $cat.Name
            if ($wanted[$domain] -and $wanted[$domain] -notcontains "*" -and $wanted[$domain] -notcontains $entityName) { continue }
            foreach ($p in $cat.Value) {
                $perm = "$($d.domain):$entityName`:$($p.action)"
                $rows += [ordered]@{
                    permission  = $perm
                    domain      = $d.domain
                    entity      = $entityName
                    action      = $p.action
                    label       = $p.label
                    description = $p.description
                }
                Write-Host ("  {0,-52} {1}" -f $perm, $p.label)
            }
        }
    }
    Write-Host ""
}

if ($rows) {
    $rows | ConvertTo-Json -Depth 6 | Set-Content ".\artifacts\permissions-catalogue.json"
    Write-Host "Resolved $($rows.Count) permissions -> artifacts\permissions-catalogue.json"
}

# Also list roles already in the org, so we can name one to extend rather than invent a new one.
Write-Host ""
Write-Host "=== candidate roles to extend ==="
try {
    $roles = Invoke-RestMethod -Uri "https://$apiHost/api/v2/authorization/roles?pageSize=200" -Headers $auth
    $roles.entities |
        Where-Object { $_.name -match 'admin|architect|integration|developer|api|ava' } |
        ForEach-Object { Write-Host ("  {0,-46} default={1}  id={2}" -f $_.name, $_.default, $_.id) }
} catch {
    $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { -1 }
    Write-Host "  roles unreadable (status $code) - client lacks authorization:role:view"
}
