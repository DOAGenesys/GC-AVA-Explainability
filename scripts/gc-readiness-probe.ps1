<#
Probes a Genesys Cloud org for everything the EventBridge -> executionHistoryUri
collection architecture depends on, before any of it is provisioned.

Answers, against the live org:
  1. Does the OAuth client hold the permissions the build needs?
  2. Is v2.flows.instances.flow.{id} available, and does it support the EventBridge transport?
  3. Does its schema carry executionHistoryUri / executionHistoryUriTtl / endpoint / executionItemsTruncated?
  4. Is historical execution data storage enabled, and at what level?
  5. Is the amazon-eventbridge-source integration type available, and are instances already configured?

Read-only. Changes nothing.
#>
[CmdletBinding()]
param(
    [string]$McpConfig = $env:GENESYS_MCP_CONFIG,
    [string]$ServerName = "ava-harness",
    [string]$OutFile = ".\artifacts\readiness-probe.json"
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

$report = [ordered]@{ probedAt = (Get-Date).ToUniversalTime().ToString("o"); apiHost = $apiHost }

function Try-Get([string]$Path) {
    try {
        return @{ ok = $true; data = (Invoke-RestMethod -Uri "https://$apiHost$Path" -Headers $auth) }
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        return @{ ok = $false; status = $code; message = $_.Exception.Message }
    }
}

function Show-Gate([string]$Label, [bool]$Pass, [string]$Detail) {
    $mark = if ($Pass) { "PASS" } else { "FAIL" }
    Write-Host ("  [{0}] {1}" -f $mark, $Label)
    if ($Detail) { Write-Host ("         {0}" -f $Detail) }
}

# ---------------------------------------------------------------- org identity
$me = (Try-Get "/api/v2/organizations/me").data
$report.org = [ordered]@{ id = $me.id; name = $me.name; shortName = $me.thirdPartyOrgName }
Write-Host "=== Org ==="
Write-Host "  $($me.name)  ($($me.id))  @ $apiHost"
Write-Host ""

# ------------------------------------------------------- 1. client permissions
Write-Host "=== 1. OAuth client permissions ==="
$client = Try-Get "/api/v2/oauth/clients/$($cfg.GENESYS_CLIENT_ID)"
$grantedPerms = @()
if ($client.ok) {
    $roles = $client.data.roleDivisions | ForEach-Object { $_.roleId } | Select-Object -Unique
    $report.oauthClient = [ordered]@{
        name        = $client.data.name
        grantType   = $client.data.authorizedGrantTypes
        roleCount   = @($roles).Count
        scopes      = $client.data.scope
    }
    Write-Host "  Client      : $($client.data.name)"
    Write-Host "  Grant type  : $($client.data.authorizedGrantTypes)"
    Write-Host "  Roles bound : $(@($roles).Count)"
    foreach ($rid in $roles) {
        $r = Try-Get "/api/v2/authorization/roles/$rid"
        if ($r.ok) {
            Write-Host "    - $($r.data.name)"
            $grantedPerms += $r.data.permissionPolicies | ForEach-Object { "$($_.domain):$($_.entityName):$($_.actionSet -join ',')" }
        }
    }
} else {
    Write-Host "  Could not read client config (status $($client.status)) - the client lacks oauth:client:view."
    Write-Host "  Falling back to probing each required endpoint directly."
    $report.oauthClient = @{ readable = $false; status = $client.status }
}
$report.grantedPermissions = $grantedPerms
Write-Host ""

# ------------------------------- 2 & 3. notification topic + schema for the topic
Write-Host "=== 2/3. Notification topic v2.flows.instances.flow.{id} ==="
# transports must be requested explicitly. Without it the response carries only 'id', and
# every EventBridge eligibility check silently reports false. Proven by gc-probe-topic-transports.ps1.
$topics = Try-Get "/api/v2/notifications/availabletopics?expand=schema,transports&pageSize=500"
if ($topics.ok) {
    $all = $topics.data.entities
    $flowTopic = $all | Where-Object { $_.id -eq "v2.flows.instances.flow.{id}" }
    if (-not $flowTopic) {
        $flowTopic = $all | Where-Object { $_.id -like "v2.flows.instances*" } | Select-Object -First 1
    }
    if ($flowTopic) {
        $transports = @($flowTopic.transports)
        $ebOk = $transports -contains "EventBridge"
        Show-Gate "Topic exists" $true $flowTopic.id
        Show-Gate "EventBridge transport supported" $ebOk ("transports: " + ($transports -join ", "))
        Write-Host "         visibility: $($flowTopic.visibility)  enforced: $($flowTopic.enforced)"
        if ($flowTopic.requiresPermissions) {
            Write-Host "         requiresPermissions: $($flowTopic.requiresPermissions -join ', ')"
        }

        # The fields that decide the whole architecture live in the topic schema.
        $schemaJson = $flowTopic.schema | ConvertTo-Json -Depth 40 -Compress
        $wanted = @("executionId", "executionHistoryUri", "executionHistoryUriTtl", "endpoint",
                    "executionItemsTruncated", "conversationId", "flowExitReason", "flowVersion", "invokingContext")
        $found = @{}
        foreach ($w in $wanted) {
            $present = $schemaJson -match ('"' + [regex]::Escape($w) + '"')
            $found[$w] = $present
            Show-Gate "schema.$w" $present ""
        }
        $report.flowTopic = [ordered]@{
            id = $flowTopic.id; transports = $transports; eventBridgeSupported = $ebOk
            visibility = $flowTopic.visibility; enforced = $flowTopic.enforced
            requiresPermissions = $flowTopic.requiresPermissions
            schemaFields = $found
        }
        New-Item -ItemType Directory -Force -Path ".\artifacts" | Out-Null
        $flowTopic.schema | ConvertTo-Json -Depth 40 | Set-Content ".\artifacts\topic-schema-flows-instances-flow.json"
        Write-Host "         full schema saved to artifacts\topic-schema-flows-instances-flow.json"
    } else {
        Show-Gate "Topic exists" $false "no v2.flows.instances* topic in this org"
        $report.flowTopic = @{ found = $false }
    }

    # Reconciliation-signal topics referenced by the architecture doc.
    Write-Host ""
    Write-Host "  Reconciliation topics:"
    foreach ($t in @("v2.detail.events.conversation.{id}.flow.end",
                     "v2.detail.events.conversation.{id}.flow.start",
                     "v2.detail.events.conversation.{id}.flow.outcome")) {
        $hit = $all | Where-Object { $_.id -eq $t }
        $eb = if ($hit) { (@($hit.transports) -contains "EventBridge") } else { $false }
        Show-Gate $t $eb $(if ($hit) { "transports: " + (@($hit.transports) -join ", ") } else { "not available" })
    }

    $ebTopics = @($all | Where-Object { @($_.transports) -contains "EventBridge" })
    Write-Host ""
    Write-Host "  EventBridge-eligible topics in org: $($ebTopics.Count) of $($all.Count)"
    $report.eventBridgeEligibleTopicCount = $ebTopics.Count
} else {
    Show-Gate "availabletopics readable" $false "status $($topics.status)"
    $report.flowTopic = @{ error = $topics.status }
}
Write-Host ""

# ------------------------------------------- 4. historical execution data state
Write-Host "=== 4. Historical execution data ==="
$exec = Try-Get "/api/v2/flows/instances/settings/executiondata"
if ($exec.ok) {
    $d = $exec.data
    Write-Host "  Raw: $($d | ConvertTo-Json -Depth 6 -Compress)"
    $report.executionDataSettings = $d
} else {
    Show-Gate "executiondata settings readable" $false "status $($exec.status) - needs architect:flowInstanceExecutionData:view"
    $report.executionDataSettings = @{ error = $exec.status }
}

$defaults = Try-Get "/api/v2/flows/instances/settings/loglevels/default"
if ($defaults.ok) {
    Write-Host "  Org default log level: $($defaults.data | ConvertTo-Json -Depth 6 -Compress)"
    $report.defaultLogLevel = $defaults.data
} else {
    Write-Host "  Org default log level: unreadable (status $($defaults.status))"
}

$overrides = Try-Get "/api/v2/flows/instances/settings/loglevels?pageSize=100"
if ($overrides.ok) {
    $n = @($overrides.data.entities).Count
    Write-Host "  Per-flow log level overrides already set: $n"
    $report.perFlowOverrideCount = $n
} else {
    Write-Host "  Per-flow overrides: unreadable (status $($overrides.status))"
}
Write-Host ""

# ------------------------------------------------- 5. EventBridge integration
Write-Host "=== 5. Amazon EventBridge integration ==="
$type = Try-Get "/api/v2/integrations/types/amazon-eventbridge-source"
Show-Gate "Integration type available in org" $type.ok $(if ($type.ok) { $type.data.name } else { "status $($type.status)" })
if ($type.ok) { $report.integrationType = @{ id = $type.data.id; name = $type.data.name } }

$ints = Try-Get "/api/v2/integrations?pageSize=200"
if ($ints.ok) {
    $eb = @($ints.data.entities | Where-Object { $_.integrationType.id -eq "amazon-eventbridge-source" })
    Write-Host "  Existing EventBridge integrations: $($eb.Count) (org limit is 10)"
    foreach ($i in $eb) {
        Write-Host "    - '$($i.name)'  state=$($i.intendedState)  id=$($i.id)"
    }
    $report.existingEventBridgeIntegrations = @($eb | ForEach-Object {
        [ordered]@{ id = $_.id; name = $_.name; intendedState = $_.intendedState }
    })
    $report.eventBridgeSlotsFree = 10 - $eb.Count
} else {
    Write-Host "  Integrations unreadable (status $($ints.status)) - needs integrations:integration:view"
    $report.existingEventBridgeIntegrations = @{ error = $ints.status }
}
Write-Host ""

New-Item -ItemType Directory -Force -Path (Split-Path $OutFile) | Out-Null
$report | ConvertTo-Json -Depth 20 | Set-Content $OutFile
Write-Host "Report written to $OutFile"
