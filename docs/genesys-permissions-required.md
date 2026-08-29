# Genesys Cloud permissions to grant

**Org:** `<GENESYS_ORG_NAME>` (`<GENESYS_ORG_ID>`, `prod-euc1`)
**OAuth client to grant them to:** `<OAUTH_CLIENT_ID>` (client-credentials grant)

Every permission string below was read from this org's own permission catalogue
(`scripts\gc-resolve-permissions.ps1` -> `artifacts\permissions-catalogue.json`), so the
labels match what you will actually see in the admin UI.

> [!NOTE]
> Two documentation corrections came out of this. **Execution data is governed by two
> separate permission families**, not one - a global `settings:executionData` pair and a
> per-flow `architect:flowInstanceExecutionData` pair. And **`architect:flowDefaultLogLevel`
> does not exist in this org**, despite appearing in the Genesys Architect permissions
> article; only `architect:flowLogLevel` is present. Do not go looking for it.

---

## How to grant

A client-credentials OAuth client gets its permissions from the **roles assigned to the
client**, not from a user. So:

1. **Admin** > **People and Permissions** > **Roles / Permissions**.
2. Either create a role, e.g. `AVA Explainability Collector`, or extend an existing
   API/integration role. A purpose-named role is preferable - it makes the blast radius
   auditable in a shared org.
3. Tick the permissions in the tables below.
4. **Admin** > **Integrations** > **OAuth** > open client `<OAUTH_CLIENT_ID>`
   > **Roles** tab > assign that role, scoped to the divisions containing the flows you want
   observed (or **Home** / all divisions).
5. Save. Then tell me, and I will re-run `scripts\gc-readiness-probe.ps1` to confirm every
   403 has cleared before anything is provisioned.

---

## Required - minimum to stand up collection

### Turning execution data on and controlling its level

| Permission | Admin UI label | Why |
|---|---|---|
| `settings:executionData:view` | Settings > Execution Data > View | read the **global** org toggle |
| `settings:executionData:edit` | Settings > Execution Data > Edit | enable the **global** org toggle |
| `architect:flowInstanceExecutionData:view` | Architect > Flow Instance Execution Data > View | read the flow execution-data level |
| `architect:flowInstanceExecutionData:edit` | Architect > Flow Instance Execution Data > Edit | set the flow execution-data level |
| `architect:flowLogLevel:view` | Architect > Flow Log Level > View | read per-flow overrides |
| `architect:flowLogLevel:add` | Architect > Flow Log Level > Add | set `All` on the test flow only |
| `architect:flowLogLevel:edit` | Architect > Flow Log Level > Edit | change that override |
| `architect:flowLogLevel:delete` | Architect > Flow Log Level > Delete | clean up afterwards |

The per-flow override permissions are what let us keep the org **default** low while
recording `All` for only our test flow. Without them, the only way to get `All` is to raise
it for every flow in the shared org.

### Identifying flows and reading execution history

| Permission | Admin UI label | Why |
|---|---|---|
| `architect:flow:view` | Architect > Flow > View or validate flow | resolve `flowId` -> flow, identify AVA-containing flows (Validation 9) |
| `architect:flow:search` | Architect > Flow > Search for brief flow information | currently **403** |
| `architect:flowInstance:view` | Architect > Flow Instance > View instance execution data for a flow | the Jobs artifact - Validations 1, 2, 3 |
| `architect:flowInstance:search` | Architect > Flow Instance > Search for brief flow execution data using criteria | last-resort forensic recovery |

`architect:flowInstance:*` is the one that gates the entire Jobs fallback path. Without it we
have EventBridge and nothing to compare it against, so Validations 1-3 cannot run and the
architecture cannot be signed off.

### Creating the EventBridge integration

| Permission | Admin UI label | Status |
|---|---|---|
| `integrations:integration:view` | Integrations > Integration > View | **already granted** |
| `integrations:integration:add` | Integrations > Integration > Add | needed - create "DO - EventBridge AVA Monitoring" |
| `integrations:integration:edit` | Integrations > Integration > Edit | needed - set config and activate |

I deliberately did not probe `add`/`edit` by attempting a write into a shared production org,
so treat these as unverified until the integration applies cleanly.

---

## Also required, given you asked me to build the test AVA flow

Needed for Deliverable C - the flow that produces guardrail blocks, timeouts, oversized
payloads and handoffs on demand (Validations 10 and 11).

| Permission | Admin UI label |
|---|---|
| `architect:flow:add` | Architect > Flow > Add flow |
| `architect:flow:edit` | Architect > Flow > Edit flow |
| `architect:flow:publish` | Architect > Flow > Publish, unpublish, activate or debug flow |
| `architect:flow:launch` | Architect > Flow > Launch an instance of a flow |
| `integrations:action:view` | Integrations > Action > View action (**already granted**) |
| `integrations:action:add` | Integrations > Action > Add action |
| `integrations:action:edit` | Integrations > Action > Edit action |
| `integrations:action:execute` | Integrations > Action > Execute action |

If you would rather not grant flow-write permissions in this org, name an existing AVA-backed
bot flow instead and I will drive scenarios through it. The cost is that guardrail blocks and
Data Action timeouts become hard to trigger deliberately, which weakens Validation 10.

---

## Deliberately not requested

| Permission | Why not |
|---|---|
| `architect:flow:delete`, `architect:flow:unlock` | destructive in a shared org; not needed |
| `integrations:integration:delete` | I will disable rather than delete; keeps the other two integrations safe |
| `authorization:role:view`, `oauth:client:view` | would only make my diagnostics prettier |
| Anything under `architect:flowDefaultLogLevel` | does not exist in this org |

---

## Verification

Once granted:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\gc-readiness-probe.ps1
```

Section 4 must read a real execution-data setting instead of `403`, and section C of
`gc-probe-details.ps1` must show `OK` for execdata settings, per-flow log levels, Architect
flows and flow-instance jobs.
