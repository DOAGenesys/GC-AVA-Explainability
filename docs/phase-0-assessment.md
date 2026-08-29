# Phase 0 assessment - readiness findings and build plan

**Target org:** `<GENESYS_ORG_NAME>`
**Org ID:** `<GENESYS_ORG_ID>`
**Habitat / region:** `prod-euc1` (AWS eu-central-1, Frankfurt)
**Platform API host:** `https://api.mypurecloud.de`
**Credential source:** `C:\Users\<user>\cursor\AVA skills MCP Cursor files\<org-folder>\mcp.json`

All findings below were probed live against the org, read-only. Nothing has been changed.
Reproduce with `scripts\gc-readiness-probe.ps1`, `scripts\gc-probe-details.ps1`, `scripts\gc-probe-topic-transports.ps1`.

> [!IMPORTANT]
> **Superseded in part, 2026-08-27.** Two of the blockers recorded here are gone, and both
> changes reduce scope and risk. Sections 1.5 and 4 below are retained as the historical
> record; read [phase-1-status.md](phase-1-status.md) for the current position.
>
> 1. **The OAuth client is now sufficient.** It holds `Master Admin`, and every operation that
>    returned 403 here now succeeds. Verified operation by operation with
>    `scripts\gc-probe-capabilities.ps1`.
> 2. **Section 3 configuration was already done.** Execution-data storage has been enabled
>    since 2024-05-13 and the org default log level has been `All` since 2023-10-06. The
>    org-wide toggle this assessment worried about enabling is already on, so no Genesys
>    configuration change is required and the section 3.1 governance concern is moot.

---

## 1. What the probes proved

### 1.1 The notification topic is available and EventBridge-eligible

`v2.flows.instances.flow.{id}` exists in this org and reports:

```text
transports = EventBridge, Websocket
```

157 of the 242 topics visible to this client carry the `EventBridge` transport. This clears
**Validation 8** for this org. Note the eligibility flag is only returned when the caller
asks for it explicitly - `GET /api/v2/notifications/availabletopics?expand=transports`.
Without the expand, the response contains only `id`, which is why a naive probe reports
zero EventBridge-eligible topics.

The three reconciliation topics named in the architecture are also present:
`...flow.end`, `...flow.start`, `...flow.outcome`.

### 1.2 The schema contains every decisive field

Confirmed present at the top level of the topic schema
(`artifacts\topic-schema-flows-instances-flow.json`):

| Field | Type | Notes |
|---|---|---|
| `executionId` | string | unique instance of the flow that ran |
| `executionHistoryUri` | string | "A signed URI to download the execution history data" |
| `executionHistoryUriTtl` | **integer** | "Time to live in **seconds**" |
| `endpoint` | string | "public endpoint a user can use to retrieve the full historical log" |
| `executionItemsTruncated` | boolean | inline items truncated to stay deliverable |
| `conversationId`, `divisionId`, `flowId`, `flowVersion`, `flowType`, `flowExitReason`, `flowIsDebug`, `messageType`, `startDateTime`, `endDateTime`, `errors[]`, `warnings[]`, `invokingContext` | | as documented |

`executionHistoryUriTtl` being an integer in seconds is useful: expiry is computable as
`eventReceivedAt + ttl`, which is exactly what the manifest needs for expiry-priority queueing.

### 1.3 The finding that changes the plan: the inline event carries no tool payloads

The inline `execution[]` array items have **only** these properties:

```text
objectType, objectId, outputPathId, executionId, startDateTime, error, warning, languageTag
```

There is no input value, no output value, no end time, no latency, no status, no tool
identity beyond an opaque `objectId`, and no knowledge or guardrail structure.

Consequences:

- The inline event cannot support AVA explainability under any circumstance, truncated or not.
  `executionItemsTruncated` is not the limiting factor - the item schema itself is.
- Downloading `executionHistoryUri` is **mandatory**, not an optimisation. There is no
  degraded mode that skips the download.
- Because there is no `endDateTime` on an execution item, per-tool latency cannot be derived
  from the event at all. It must come from the downloaded artifact, or the architecture's
  Section 10 tool-boundary telemetry.
- The event is best understood as a *trigger plus correlation envelope*: it tells you an
  execution exists, gives you its identity, and gives you a short-lived way to fetch the real data.

This raises the stakes on **Validation 5** (TTL and expiry). If the TTL is short, the
download has to happen inline in the consumer, not on a leisurely batch schedule. That is
why the collector Lambda downloads on receipt rather than deferring.

### 1.4 The EventBridge integration type is available, and two instances already exist

`amazon-eventbridge-source` is installable in this org. Its property contract is:

| Property | Required | Constraint |
|---|---|---|
| `awsAccountId` | yes | `^\d{12}$` |
| `awsAccountRegion` | yes | e.g. `eu-central-1` |
| `eventSourceSuffix` | yes | `^[.\-_a-zA-Z0-9]{1,64}$`, unique per org |
| `eventFilter` | no | array of topic id strings; **empty means no events are sent** |

Two instances are already configured in the org (limit is 10, so 8 slots free):

| Name | State | AWS account | Region | Suffix | Topics |
|---|---|---|---|---|---|
| AVA Monitoring EventBridge Integration | **ENABLED** | `640005036677` | `us-west-2` | `ava-monitoring-81483d3a-...` | `...customer.end`, `...flow.end`, `...conversations.summaries`, `v2.quality.evaluations` |
| Amazon EventBridge Source | DISABLED | - | - | - | none (empty config) |

Two things matter here:

1. Somebody else's AVA monitoring pipeline is live in this org, pointing at AWS account
   `640005036677` in us-west-2. **We must not modify or reuse it.** We add a new,
   separately-suffixed integration.
2. That existing integration deliberately does *not* subscribe to
   `v2.flows.instances.flow.{id}`. So the rich execution-history stream is currently
   uncaptured - which is precisely the gap this project fills.

The partner event source Genesys will create for us is named:

```text
aws.partner/genesys.com/cloud/<GENESYS_ORG_ID>/<our-suffix>
```

### 1.5 The OAuth client is not yet sufficient

Probed operation by operation (`artifacts\permission-probe.json`):

| Operation | Result | Needed for |
|---|---|---|
| read org | OK | context |
| list notification topics | OK | Validation 8 |
| list integrations | OK | discovery |
| read integration type + config schema | OK | building the integration |
| list data actions | OK | test-flow build |
| read execution-data settings | **403** | turning execution data on at all |
| read org default log level | **403** | keeping the org default low |
| read per-flow log levels | **403** | setting `All` on just our test flow |
| list Architect flows | **403** | identifying/building the test flow |
| list flow-instance jobs | **403** | Jobs fallback, Validations 1-3 |
| read own OAuth client | 403 | cosmetic only, ignore |

Write capability on integrations (`integrations:integration:add` / `edit`) is **untested** -
listing proves only `view`. I did not probe it because the only safe probe would write to a
shared production org.

---

## 2. What we are building

Three deliverables, in dependency order.

### Deliverable A - the evidence rig (this is what gets you real samples)

```text
Genesys Cloud (Frankfurt)
  -> v2.flows.instances.flow.{id}
  -> partner event source  aws.partner/genesys.com/cloud/<orgId>/<suffix>
  -> custom event bus (same name)
  -> rule
       |-- target 1: CloudWatch Logs group        (raw envelope, human-readable, 7d retention)
       |-- target 2: SQS queue + DLQ  -> Lambda "collector"
                                          |-- envelope            -> s3://.../bronze/envelope/
                                          |-- manifest row        -> DynamoDB  pk = orgId:executionId
                                          |-- GET executionHistoryUri -> s3://.../bronze/history-direct/
                                          |-- download probe metadata -> s3://.../bronze/probe/
```

The probe record is deliberate. For every download it captures HTTP status, response
headers, final hostname after redirects, byte count, wall-clock duration, whether any auth
header was required, and the observed TTL vs actual expiry. That single artifact feeds
**Validations 4, 5 and 6** without any extra work.

Terraform, two stacks, because the partner event source only appears in AWS roughly five
minutes after Genesys activates the integration:

- `infra/genesys/` - the `genesyscloud_integration` resource
- `infra/aws/` - bus, rule, log group, SQS, DLQ, Lambda, S3, DynamoDB, IAM
- `scripts/wait-for-partner-source.ps1` - polls `ListEventSources` between the two applies

### Deliverable B - the validation harness

A local CLI that, given a captured `executionId`, produces the Section 11 evidence:

| Script | Validation |
|---|---|
| `harness/fetch_direct.py` | re-fetch the signed URI; prove expiry behaviour (V5) |
| `harness/probe_endpoint.py` | resolve `endpoint` semantics, auth, refresh behaviour (V4) |
| `harness/jobs_compare.py` | `POST /flows/instances/jobs` with the event's `executionId` (V3), default + every supported expand (V2) |
| `harness/semantic_diff.py` | structural and field-level diff of direct vs Jobs artifacts (V1) |
| `harness/load_probe.py` | concurrency ramp on signed downloads, capture 429/5xx (V6) |

Output lands in `docs/validation-log.md` as a gate-by-gate record.

### Deliverable C - the AVA test flow that exercises the matrix

A purpose-built AVA plus mock Data Actions that can be driven on demand to produce, on
separate executions: Data Action success, timeout, error, guardrail block, knowledge
lookup, containment, handoff, escalation, nested flow invocation, and deliberately oversized
payloads (JSON > 1000 chars, string > 253 chars, collection > 20 items) for **Validation 11**.

This is Validation 10, and it is the reason for building a flow rather than harvesting
ambient traffic: you cannot get a guardrail block or a timeout on demand from someone else's
demo.

---

## 3. Open governance question - this is a shared org

You initially specified a dedicated test org; the config supplied points at
`<GENESYS_ORG_NAME>`, which is a shared EMEA presales org with 25+ AVAs from many
authors and a live third-party monitoring pipeline.

Two side effects are unavoidable and org-wide:

1. **Execution-data storage is an org-level toggle.** Enabling it affects every Architect flow
   in the org and counts against the org's fair-use data storage. It cannot be scoped to one flow.
   *Mitigation:* enable storage, but leave the org **default** level at `Base` and apply an
   `All` override only to our test flow. This depends on per-flow log level overrides being
   available - the API returned 403 so I could not confirm, and the Terraform resource for it
   (`genesyscloud_flow_loglevel`) is documented as beta behind a feature toggle.

2. **Topic subscription is org-wide.** `{id}` is not parameterised. Every flow execution in the
   EMEA presales org - all authors, all demos - will be delivered to your AWS account. AWS-side
   rule filtering controls what we *store*, not what *arrives*. Since the org is in Frankfurt,
   this is EU conversation data leaving to whatever account and region you nominate, so
   **eu-central-1 is the recommended region** and a genuinely dedicated org would be the
   cleaner answer if one is available.

---

## 4. What is still needed

### 4.1 Genesys Cloud - permissions on the existing OAuth client

Client `<OAUTH_CLIENT_ID>` needs a role adding these permissions:

```text
integrations:integration:add
integrations:integration:edit
architect:flowInstanceExecutionData:view
architect:flowInstanceExecutionData:edit
architect:flowDefaultLogLevel:view
architect:flowDefaultLogLevel:edit
architect:flowLogLevel:add
architect:flowLogLevel:view
architect:flowLogLevel:edit
architect:flowLogLevel:delete
architect:flow:view
architect:flow:search
architect:flowInstance:view
architect:flowInstance:search
```

Add `architect:flow:add`, `architect:flow:edit`, `architect:flow:publish` if I am to build
the test flow (Deliverable C) rather than being handed an existing one.

### 4.2 AWS - everything

| Item | Notes |
|---|---|
| 12-digit account ID | must match `^\d{12}$` |
| Region | **eu-central-1 recommended** - matches the org's habitat, keeps EU data in EU |
| Access key ID + secret | throwaway IAM user; loaded as env vars only, never written to this repo |
| IAM permissions | `AdministratorAccess` in a test account is simplest; otherwise `events:*`, `sqs:*`, `lambda:*`, `s3:*`, `dynamodb:*`, `logs:*`, `cloudwatch:*`, and `iam:` role create/attach/pass/get/delete |
| SCP confirmation | no Organizations SCP blocking partner event sources or the chosen region |

### 4.3 Confirmations

- Go-ahead to write to the shared presales org, given section 3.
- Whether to configure the abandoned DISABLED `Amazon EventBridge Source` integration or
  create a fresh one (recommended: fresh, suffix `ava-explain-<initials>`).
- Whether captured samples may be committed to this repo. Default assumption is **no** -
  `artifacts/` and `samples/` are gitignored, since real conversation content is in scope
  at `Verbose Notes` and above.
