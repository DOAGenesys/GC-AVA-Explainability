# Validation log - Section 11 gates

Gate-by-gate record. Every result below was produced by a live probe against
`<GENESYS_ORG_NAME>` (`<GENESYS_ORG_ID>`, habitat `prod-euc1`,
`api.mypurecloud.de`) into AWS account `123456789012` / `eu-central-1`, and each is reproducible
with the named script.

**Last updated:** 2026-08-27

## The three findings that matter most

**1. The notification does not carry a signed download URI.** `executionHistoryUri` and
`executionHistoryUriTtl` were absent on **0 of 30** delivered events, spanning 8 distinct flows and
4 flow types (`digitalbot`, `inboundshortmessage`, `workflow`, plus the conversation flow-end
topic). Not sometimes-absent - never present. The architecture's happy path ("download from the
signed URI, fall back to Jobs") therefore has no happy path. Every retrieval route goes through
the Jobs API. This simplifies the design rather than breaking it, but it invalidates Sections 4
and 5 as written and makes gate 5 (TTL and expiry) moot.

**2. Delivery is reliable on a properly configured AVA flow; an earlier loss finding was an
artifact of the wrong test flow.** Driving 4 executions against a flow that genuinely invokes an
AVA produced **4 notifications - 100%**. An earlier run reported 2 of 24, but that used
`DO - G Rail FAQ Agent`, which turned out to invoke a *standard* virtual agent and a Guide rather
than an AVA, and which lost its `agenticVirtualAgentEnabled` flag partway through the day. The
loss figure is therefore withdrawn as a general claim. Reconciliation remains worth having, and
`harness/reconcile.py` is what established both the wrong answer and the right one - but it is a
safety net again, not the primary integrity mechanism.

**3. An execution that never reaches the flow's own exit produces no explainability data at all.**
A bot session closed by a user disconnect while the bot was still waiting for input leaves *no*
execution history: absent from `/api/v2/flows/instances/query`, and the Jobs API answers 404 for
the id. No history means no notification, so the pipeline never sees it. Measured on two different
digital bot flows, including one that had already delivered 4 of 4 events when its sessions ran to
completion - the variable is how the execution ended, not which flow it was. The corollary for the
architecture is that *abandoned conversations are structurally invisible to this pipeline*, and
the corollary for testing is that a harness must drive a flow to its own exit before any delivery
number it reports means anything (see "Two measurement defects" below).

## Gate summary

| Gate | Status | Notes |
|---|---|---|
| 1 - retrieval-route equivalence | **PASS (reframed)** | no signed URI exists; the two Jobs routes are byte-identical |
| 2 - Jobs `expand` effect | **PASS** | `bots`, `dataActions` change nothing, on 2 executions |
| 3 - `executionId` accepted by Jobs `ids[]` | **PASS (definitive)** | id taken from a real notification |
| 4 - `endpoint` semantics | **PASS** | relative API path; a GET creates a Jobs job |
| 5 - signed URI TTL and expiry | **NOT APPLICABLE** | no signed URI is ever issued |
| 6 - download throughput / batching | **PASS** | ceiling is exactly 10 ids/job; batched jobs DO return `downloadUri`, so 0.2 API calls per execution |
| 7 - EventBridge delivery semantics | **PARTIAL** | 0 duplicates in 17 events; ordering untested |
| 8 - topic availability and schema | **PASS** | schema declares the URI fields that are never populated |
| 9 - identifying AVA-containing flows | **PASS, with a drift caveat** | 59 of 631 flows; the count moved 59 -> 58 -> 59 within one day |
| 10 - AVA field completeness | **PARTIAL - 6 of 11 scenarios** | across 23 distinct executions; Data Action error now observed with a real 404 |
| 11 - truncation impact | **PASS** | documented limits do not bind; 1,732-char payloads stored intact |
| 12 - reconciliation proves no silent loss | **PASS** | 4 of 4 delivered on a real AVA flow |

---

## Deployment state

| Component | State |
|---|---|
| Genesys integration `DO - EventBridge AVA Explainability` | `<EVENTBRIDGE_INTEGRATION_ID>`, ENABLED |
| Topics subscribed | flow-instance template, conversation flow-end, plus one concrete flow id |
| Partner event source | `aws.partner/genesys.com/cloud/81483d3a-.../do-eventbridge-ava-explain`, ACTIVE since 2026-08-27 09:28 UTC |
| AWS | account `123456789012`, `eu-central-1`, 25 resources |
| Bronze bucket | `ava-explain-bronze-123456789012-eu-central-1` |
| Manifest | `ava-explain-manifest` |
| Turn sweep | `ava-explain-turns-sweep`, hourly, into `ava-explain-turns` (since 2026-10-26) |
| Web reader | `ava-explain-web-reader`, assumed by the Vercel production deployment through OIDC |
| Flow filter | none - unfiltered capture during discovery |
| Discovery logging | on, catch-all rule to `/aws/events/ava-explain/raw`, 7-day retention |

Health at last check: 30 events on the bus across 8 flows and 4 flow types, 13 execution-history
artifacts recovered into `bronze/history-jobs/`, 0 Lambda errors, empty DLQ. Recovery has succeeded
on 13 of 13 attempts. The collector has never failed. Ambient org traffic began arriving during the
afternoon, so the pipeline is now capturing real third-party executions as well as driven ones.

### The pipeline is proven end to end

Because no notification carries a signed URI, the collector alone can only ever store envelopes.
`harness/recover_jobs.py` closes the loop, and the full path has now been exercised on real data:

```text
driven flow execution
  -> v2.flows.instances.flow.{id} notification
  -> partner event bus -> rule -> SQS -> collector Lambda
  -> Bronze envelope + manifest row RECOVERY_REQUIRED
  -> Jobs recovery sweep
  -> Bronze bronze/history-jobs/dt=.../org=.../<executionId>.json
  -> manifest ARCHIVED with byte count and SHA-256
```

Both executions recovered on the first attempt, 7,974 and 6,268 bytes. The 7,974-byte artifact
hashes to `7ba69fef15e2cfae...`, matching the gate 1 and gate 4 downloads of the same execution
byte for byte, so the stored Bronze object is provably the same artifact the direct probes
retrieved.

## New tooling built to close these gates

The gates were blocked on a shared org being quiet, which made the critical path a matter of
waiting for someone else to run a demo. These remove that dependency:

| Script | Purpose |
|---|---|
| `harness/drive_bot_flow.py` | creates real flow executions on demand via the textbot session API |
| `harness/reconcile.py` | three-way driven / platform / manifest comparison - gate 12 |
| `harness/bus_audit.py` | reads every event on the bus across all log streams |
| `harness/recover_jobs.py` | retrieves history via bulk Jobs for `RECOVERY_REQUIRED` rows, and with `--execution-id` backfills executions that never produced an event at all (so the manifest has no row to scan) |
| `harness/pull_history.py` | brings Bronze history artifacts local so the analysis scripts can read them |
| `harness/spec_grep.py` | now caches the 22 MB definition and supports `--paths` and `--detail` |
| `harness/ava_coverage.py` | now scans several artifact directories and deduplicates on execution id, so gate 11's sample is distinct executions rather than copies |
| `harness/probe_reporting_turns.py` | baselines the Bot Flow Reporting Turns API before next week's turn-level metadata release, so the delta is measured rather than read off a release note |

### Two measurement defects found in this tooling, and fixed

Both produced confident, wrong delivery numbers, and both are worth recording because the same
mistakes are available to anyone building a reconciliation job against this API.

**1. A successful Jobs job does not mean the platform holds the data.** The job reports per-id
outcomes. An id with no retained history comes back as an entity carrying
`{"id": ..., "failed": true, "statusCode": "404"}` and no `downloadUri`, inside a job whose
`jobState` is `Success`. `reconcile.py` and `recover_jobs.py` both read presence as "the job
succeeded and returned entities", which marks every id present - a freshly invented UUID included,
verified directly. The effect was a reported "platform retained, never notified" verdict, which
reads as EventBridge data loss, for executions the platform had never heard of. Presence is now
read from the per-entity `failed` flag. Re-running the corrected check against the 4 genuine
bceacc0b executions still returns 4 of 4, so no previously recorded gate result changes.

**2. Forcing a disconnect does not manufacture an observable execution.** `drive_bot_flow.py` sent
`UserDisconnect` when its script ran out while the bot was still asking questions, on the
assumption that ending the session ends the execution and therefore emits the event. It does not -
that is finding 3 above. Sessions ending `Disconnect/TriggeredByUser` yielded nothing; sessions
ending `Exit/TriggeredByFlow` yielded history and an event every time. The driver now records
`flowReachedOwnExit` per session, warns when it is false, and `reconcile.py` excludes those
sessions from the expected set instead of counting them as delivery misses.

---

## Prerequisite: Section 3 configuration - ALREADY SATISFIED

Reproduce: `scripts\gc-probe-capabilities.ps1`

Section 3 treats enabling historical execution data as mandatory work with org-wide side effects.
In this org it was already done years ago:

| Setting | Value | Last modified |
|---|---|---|
| Execution-data storage enabled | `true` | 2024-05-13 |
| Org default log level | `All` | 2023-10-06 |

`All` is exactly the level required for tool input/output visibility, and it is the org
**default**, so every flow is recorded at full detail. No Genesys configuration change was
needed, the Phase 0 governance concern about flipping an org-wide toggle was moot, and a
population of fully-detailed historical executions already existed to validate against.

---

## Generating events on demand - the precondition for gates 1, 4, 6, 7 and 12

Reproduce: `python harness\drive_bot_flow.py --flow-id <id> --sessions N --concurrency C`

`POST /api/v2/textbots/botflows/sessions` is documented as "Create an execution instance of a bot
flow definition", which is precisely the object this architecture is built around. Driving it
produces a genuine flow execution without placing a call or messaging anyone. 24 executions were
created this way against `DO - G Rail FAQ Agent` (`c9f5f500-...`), a DIGITALBOT AVA flow belonging
to the requesting user rather than to another author.

**`executionId` is the textbot `sessionId`.** The session id returned at launch is the same value
that appears as `executionId` on the notification and is accepted by the Jobs API. That is what
makes a driven run self-verifying: the expected set is known before any event arrives. Verified
directly: the four session ids from the bceacc0b batch are exactly the four execution ids
`/flows/instances/query` returns for that flow.

**But the driven session has to reach the flow's own exit to be observable at all.** Enough
`--say` turns to complete the conversation is a correctness requirement of this harness, not a
matter of thoroughness - see finding 3 and "Two measurement defects" above.

### Five contract corrections found while building the driver

The spec alone was insufficient for all five, which is why they are recorded rather than quietly
fixed:

1. **`inputData` is required** despite being optional in the spec. Omitting it returns
   `Validation failed: inputData: must not be null`. `{"variables": {}}` satisfies it.
2. **A user input alternative is `{"transcript": {"text": ..., "confidence": ...}}`.** The spec
   models `alternatives` as an untyped array. Neither `utterance` nor a bare string `transcript`
   is accepted; the first returns a field-level 400, the second a bare "malformed syntax" 400.
3. **`NoOp` as a *response* means "keep polling", not "finished".** It is what the flow returns
   while an action such as an AVA invocation runs, usually with a `Typing` prompt attached.
   Treating it as terminal ends the session before the AVA is ever invoked and produces an
   execution containing no AVA turn at all - a silently empty test.
4. **`textPrompts.segments` is the prompt path**, and its shape varies by flow type. Walking the
   prompt subtree for `text` is more durable than indexing a fixed path.
5. **The session must be driven to a terminal state.** The notification is emitted on flow end,
   so abandoning a session can mean no event is ever produced.

---

## VALIDATION 1 - retrieval-route equivalence - PASS (reframed)

The gate as written asks whether `executionHistoryUri` returns the same bytes as the Jobs
artifact. That question cannot be asked: no event carries a signed URI. The equivalent question
for the two routes that do exist was tested instead, on execution
`e56de3cf-1e40-5b6b-aad3-4a6b2b575c7f`:

| Route | Bytes | SHA-256 |
|---|---:|---|
| `endpoint` -> job -> download | 7,974 | `7ba69fef15e2cfae...` |
| bulk `POST /jobs` -> download | 7,974 | `7ba69fef15e2cfae...` |

**Byte-identical.** Retrieval route is a performance and quota decision, not a fidelity one.

## VALIDATION 5 - signed URI TTL and expiry - NOT APPLICABLE

`executionHistoryUri` was absent on **0 of 30** delivered events, and `executionHistoryUriTtl`
with it. Confirmed by `bus_audit.py` reading every stream of the raw bus log, so this is not an
artifact of collector parsing. The population includes ambient traffic from other authors' flows
across `digitalbot`, `inboundshortmessage` and `workflow` types, so it is not specific to how
these executions were created.

The companion topic `v2.detail.events.conversation.{id}.flow.end` delivered 6 of the 30 events and
carries **neither** `executionId` nor `endpoint` - `items=0`. It is a conversation-level signal
only, useful for reconciliation triggers but not for retrieval.

The topic schema does declare both fields - "A signed URI to download the execution history data"
and "Time to live in seconds" - with no conditionality documented. So the fields are simply
optional and unpopulated in this org. Two consequences:

- The collector's `RECOVERY_REQUIRED` path is not an error path, it is the **only** path. Both
  manifest rows carry `recoveryReason: "no executionHistoryUri in event"`, which is the collector
  correctly reporting reality rather than a fault.
- Section 4's "signed URI expires before we can use it" risk, and the entire TTL-arithmetic
  design around `calculatedExpiryAt`, address a problem that does not exist here.

> [!IMPORTANT]
> Do not remove the TTL handling. The field is in the published schema, so it may be populated
> for other orgs, other flow types, or larger executions. Treat its absence as the observed
> default and the code path as defensive.

---

## VALIDATION 2 - Jobs `expand` options - PASS

Reproduce: `python harness\jobs_compare.py --execution-id <id>`

The supported vocabulary, read from the live 22 MB OpenAPI definition, is `["bots", "dataActions"]`.
Four variants were run against two different real AVA executions. On both, all four variants were
**byte-identical** (31,941 bytes / `15fe4796208c2f2c...` on the first; 7,974 bytes /
`7ba69fef15e2cfae...` on the second). The expansions add nothing.

**Architecture impact.** This was flagged as "the most important check after Validation 1"
because a signed URI might have pointed at a base artifact while Jobs applied enrichment. There
is no enriched Jobs variant, so nothing is lost by retrieval route.

### Three earlier contract corrections, still worth keeping

1. **`expand` is a query parameter**, not a body field. An `expands` array in the body is ignored
   rather than rejected, so this gate would have "passed" while testing nothing.
2. **The values are plural.** `bot` and `dataAction` are both rejected.
3. **Terminal `jobState` values are `Success` and `Failed`** (enum: `Registered`, `Running`,
   `Success`, `Failed`). Polling for `Complete` never matches and burns the whole timeout.

## VALIDATION 3 - `executionId` accepted by the bulk Jobs API - PASS (definitive)

Previously indicative, because the ids came from the query API rather than from an event. Now
closed: `e56de3cf-1e40-5b6b-aad3-4a6b2b575c7f` was taken from a captured notification, submitted
as `{"ids": [...]}`, reached `jobState: Success`, and returned a usable `downloadUri`. The
identifier on the notification is the identifier Jobs expects.

One naming trap remains: the query API returns the execution identifier as **`id`**, not
`executionId`.

---

## VALIDATION 4 - `endpoint` semantics - PASS

Reproduce: `python harness\probe_endpoint.py --event artifacts\samples\<id>.json`

```text
endpoint = "api/v2/flows/instances/e56de3cf-1e40-5b6b-aad3-4a6b2b575c7f"
```

| Probe | Result |
|---|---|
| Form | **relative API path** - no scheme, no host |
| Anonymous GET | 401 |
| Authenticated GET | 200, 144 bytes |
| Redirects | none; no `Location`, no freshly-signed URI |
| Response body | `{"id", "jobState": "Running", "selfUri"}` |

**A GET on `endpoint` creates an execution-data job.** It is not a content address at all - it is
a per-execution convenience wrapper over the Jobs API. Polled to `Success` it yielded the same
7,974-byte artifact as the bulk route.

**Architecture impact.** `endpoint` is durable and re-fetchable with no TTL, which is what the
gate hoped for. But it is not a *cheaper* path than Jobs, and it cannot batch - one job per
execution. So bulk `POST /jobs` is strictly better for the collector, and `endpoint` is best
understood as the convenient manual route for a single execution during investigation.

---

## VALIDATION 6 - retrieval throughput and batching - PASS

Reproduce: `python harness\probe_jobs_cost.py --execution-id <id> --execution-id <id> ...`

Because retrieval is entirely Jobs-based, the meaningful throughput question is batching rather
than signed-URI download concurrency. This gate was PARTIAL on two open questions, and both are
now answered - one of them by overturning what was recorded here.

| Observation | Value |
|---|---|
| Batch of 10 ids | accepted |
| Batch of 11 ids | **422** `The input data is not valid` |
| **Exact batch ceiling** | **10 ids per job** |
| API calls per job (POST + one poll to `Success`) | **2** |
| `downloadUri` on entities of a **batched** job | **present, one per entity** |
| Host serving `downloadUri` | `api-downloads.mypurecloud.de`, not the API host |

**Correction: batched jobs do return content.** This log previously recorded that batch entities
carry no `downloadUri`, "unlike the single-id job which does return one", and `recover_jobs.py` was
built on that belief - it establishes retrievability in bulk and then fetches every artifact with
its own single-id job. Measured directly, a 4-id job returned `["downloadUri", "failed", "id",
"statusCode"]` for all four entities, with or without `expand`. The earlier reading came from
batches whose entities were 404 failures, which carry no URI for the obvious reason. So the
per-execution retrieval cost is not one job per execution.

**The resulting cost model.** Ten executions cost 2 API calls, so **0.2 API calls per execution**,
plus one content download per execution from `api-downloads.mypurecloud.de` - a different host from
the Platform API, so the bytes do not consume API budget. Against the one-job-per-execution shape
the collector currently implements, batching at the ceiling is a **10x reduction** in API calls.
That is the difference between the architecture's stated goal being comfortable and being strained,
and it is available today with no platform change.

No `inin-ratelimit-*` headers were returned on the endpoints probed, so the sustainable rate is not
yet expressible as a number from measurement; that is the one part of this gate still worth
establishing under load.

**Batching is all-or-nothing and gives no per-id diagnostics.** A rejected batch returns a bare
422 naming no id. Naive batching therefore reports every execution in the batch as absent, which
is indistinguishable from catastrophic data loss - this exact failure produced a "0 of 15 retained"
reading before the reconciler was taught to bisect. Any production collector must bisect on
failure, and `reconcile.py` does.

---

## VALIDATION 7 - EventBridge delivery semantics - PARTIAL

| Question | Observation |
|---|---|
| Duplicate delivery | 0 duplicates across 30 events (`duplicateDeliveries` counter) |
| Ordering | not assessed |
| Event before history is downloadable | not observed - all 13 recovered on first attempt |
| Retry window | not exercised; the collector has never failed |

Honest position: 30 events with no duplicates is suggestive, not conclusive, and says nothing
about ordering or about behaviour under retry. The instrumentation is in place and correct - the
manifest counts redeliveries via a conditional write, and the collector records a probe per
download - but exercising it needs deliberate fault injection rather than more volume.

---

## VALIDATION 8 - topic availability and schema consistency - PASS

Reproduce: `scripts\gc-probe-topic-transports.ps1`, `scripts\gc-readiness-probe.ps1`

```text
v2.flows.instances.flow.{id}   transports = EventBridge, Websocket
EventBridge-eligible topics    157 / 242
```

All five decisive schema fields are declared: `executionId`, `executionHistoryUri`,
`executionHistoryUriTtl`, `endpoint`, `executionItemsTruncated`. Schema captured at
`artifacts\topic-schema-flows-instances-flow.json` as the versioned onboarding baseline.

**Caveat this gate cannot see.** Schema presence is not field population. Two of the five fields
are declared and never populated. A schema-only readiness check therefore passes on an org where
the architecture's primary retrieval mechanism is unavailable, so onboarding must assert against
a *captured event*, not against the schema.

### A probe artefact worth knowing about

`transports` is only returned when explicitly requested. `GET /notifications/availabletopics`
without `expand=transports` returns just `id`, and every eligibility check then reports false.
This produced a false negative in `gc-readiness-probe.ps1`, which requested `expand=schema`
alone; it now requests `expand=schema,transports`.

### The captured event shape

Also not visible from the schema: the notification is nested three deep.

```text
EventBridge envelope  -> detail
Genesys notification  -> eventBody   (alongside topicName, metadata, timestamp)
the useful fields     -> executionId, endpoint, execution[], flowExitReason, ...
```

Unwrapping only `detail` leaves you looking at `topicName`/`eventBody`/`metadata` and concluding
the event has no `executionId`. `gcapi.load_event` now peels both layers.

---

## VALIDATION 9 - identifying AVA-containing flows - PASS

Reproduce: `scripts\gc-build-ava-registry.ps1` -> `artifacts\ava-flow-registry.json`

The cheapest reliable filter is published on the flow object itself, so neither per-execution
inspection nor an out-of-band metadata cache is needed. `GET /api/v2/flows` returns
`virtualAgentEnabled` and `agenticVirtualAgentEnabled` with no `expand`, so one paged read
(4 pages, 631 flows) gives the complete answer.

| Population | Morning build | Afternoon rebuild |
|---|---:|---:|
| All flows in org | 631 | 631 |
| `agenticVirtualAgentEnabled = true` | 59 | **58** |
| `virtualAgentEnabled` only | 91 | 92 |
| BOT + DIGITALBOT flows | 294 | 294 |

Afternoon split: 30 of 124 `BOT`, 28 of 170 `DIGITALBOT`. No AVA-enabled flows exist outside those
two types, across all 16 flow types present, confirming the architecture's assumption that only
bot-like flows matter.

**Architecture impact.** The gate's premise - that `flowType=BOT` does not prove an AVA ran - is
confirmed and quantified: only **19.7%** of bot-like flows are AVA-enabled. Filtering to these 58
ids avoids roughly **80%** of bot-flow execution-history volume. Wired as `ava_flow_ids` in
`infra/aws`, currently empty so nothing is discarded during discovery.

> [!WARNING]
> **The flag drifts, and it drifted during this engagement.** `DO - G Rail FAQ Agent` was
> `agenticVirtualAgentEnabled = true` in the morning build and absent from the afternoon rebuild;
> its recovered artifacts contain `actionCallGuide` and no AVA node. Selecting a test flow from a
> few-hours-old registry produced four runs of invalid results and a withdrawn finding under
> gate 12.
>
> Two consequences. Rebuild the registry immediately before each collection window, not daily. And
> treat the flag as a *pre-filter* only - confirm AVA presence from
> `actionCallAgenticVirtualAgent` in a recovered artifact before drawing conclusions from a flow.
> A flow that had its AVA removed still emitted AVA executions historically, and a flow the flag
> claims is AVA-enabled may no longer invoke one.

---

## VALIDATION 10 - AVA field completeness across scenarios - PARTIAL

Reproduce: `python harness\ava_coverage.py`

Scanned over **23 distinct executions**, of which 6 contain genuine
`actionCallAgenticVirtualAgent` nodes, carrying 15 tool invocations.

| Scenario | Observed | Notes |
|---|---|---|
| Data Action success | yes | full identity, inputs, outputs, latency |
| Data Action error | yes | a real tool 404 body, captured verbatim in `successOutput` |
| Data Action timeout | no | no captured execution timed out |
| Guardrail block | no | **withdrawn** - previously credited to a Guide, not an AVA |
| Knowledge lookup | no | **withdrawn** - same reason |
| AVA containment | no | observed exit reasons `TriggeredByUser`, `Success`, `Transfer.Queue`, `Error` |
| Human handoff | yes | `actionTransferToAcd` |
| Customer escalation | yes | `eventAgentEscalation` |
| Nested flow invocation | yes | `actionCallDigitalBotFlow`, `actionCallTask` with nested `execution[]` |
| Digital bot flow | yes | `turn.fromParticipant.digital`, `turn.toParticipant.digitalItems[]` |
| Voice bot flow | no | no voice AVA execution captured |

**6 of 11 observed.** The figure has moved twice and the reasons are worth separating. It was
revised *down* from 7 to 4 when the guardrail-block and knowledge-lookup credits were withdrawn -
those were inferred from conversational behaviour on `DO - G Rail FAQ Agent`, whose artifacts
contain no AVA node, so whatever produced those refusals was a Guide and a standard virtual agent.
Counting them was reading the transcript instead of the artifact. It then moved *up* to 6 for two
sound reasons: the scan was only ever looking at one of the two directories artifacts are written
to, and a real Data Action error was captured for the first time (see "The retail AVA's failure,
from the artifact" below).

"Not observed" still means no captured execution exercised the scenario, not that the schema lacks
it. This gate still needs Deliverable C - the three remaining gaps are a timeout, a genuine AVA
guardrail block and a knowledge lookup, none of which ambient traffic has produced.

### A counting defect in this scan, and what it was inflating

`jobs_compare.py` writes one artifact per `expand` variant, so the same execution is on disk four
times over, and Bronze pulls duplicate what the compare runs already downloaded. The scan counted
every copy, which multiplied the gate 11 sample: what was reported as 20 tool invocations was 5
distinct executions counted repeatedly. `ava_coverage.py` now deduplicates on
`flow.flowExecutionId` and takes multiple `--dir` arguments, defaulting to both directories. On the
same artifacts that turns 34 files into 23 distinct executions and 20 apparent tool invocations
into 15 real ones. The direction of the error is worth noting: it did not change which scenarios
were observed, but it made the truncation sample look 33% larger than it was.

### What the artifact actually contains

The AVA trace lives at
`$.flow.execution[].actionCallTask.execution[].actionCallAgenticVirtualAgent`, with per
invocation:

```text
inputData.agenticVirtualAgentId / agenticVirtualAgentName
inputData.inputs[].inputName / value
outputData.exitReason
outputData.outputs[].outputName / value
execution[].turn.fromParticipant.digital.text          <- customer utterance
execution[].turn.toParticipant.digitalItems[].text     <- AVA response
execution[].turn.tools[]                               <- the tool calls
```

and per tool call in `turn.tools[]`:

```text
toolId, toolName, toolExecutionId
startDateTime, endDateTime                 -> latency is derivable
dataAction.id
dataAction.input.<field>                   -> full input payload, as named fields
dataAction.successOutput                   -> full response payload, as a JSON string
dataAction.isSecure
dataAction.dependencyOnlyInput
```

Measured on 15 distinct real tool invocations: 15/15 had name, start and end; 15/15 had captured
input fields; 14/15 had a captured output payload.

`dataAction.successOutput` is the significant one. It is not a reference or a variable name - it
carries the Data Action's **full JSON response body** serialised as a string, 17 to 526 characters
observed, including complete nested CRM record structures.

**Architecture impact.** Section 10 treats external tool-boundary telemetry as an option to add
"if historical-execution truncation prevents the required analytics". The Genesys record alone
does carry full tool request *and* response payloads, so that augmentation is genuinely optional
rather than implicitly mandatory - subject to Validation 11.

Also present: 29 distinct action/event types including `actionCallData`, `actionAskForIntent`
(with `enabledIntents[]` and resolved `outputVariables[]`), `actionCallGuide`, `actionCommunicate`,
`actionExitBotFlow`, `startedBotState` / `endedBotState`, `eventAgentEscalation`,
`eventSessionDisconnected`, `eventVariablesUpdated`, and
`$.flow.executionInfo.characteristics.*` recording which categories were captured.

---

## VALIDATION 11 - truncation impact - PARTIAL

Reproduce: `python harness\ava_coverage.py`

| Documented limit | Value | Observed maximum | Reached? |
|---|---:|---:|---|
| JSON value | 1,000 chars | **1,732 chars** (`dataAction.successOutput`) | **exceeded** |
| String value | 253 chars | **2,918 chars** | **exceeded** |
| Collection | 20 items | **253 items** | **exceeded** |

**All three documented limits were exceeded by real stored data and retrieved intact.** Section
10's table is not a cap on the execution-history artifact.

The JSON figure is the one that matters, and it is the correction that changes a conclusion. All 5
`dataAction.successOutput` values on the genuine AVA executions were **1,732 characters** - 73%
over the documented 1,000-character limit - stored complete, with `$.flow.isTruncated = False` on
all 13 artifacts and no `valueIsTooLarge` marker anywhere.

**Architecture impact.** Section 10 offers external tool-boundary telemetry as a fallback "if
historical-execution truncation prevents the required analytics". On this evidence the Genesys
record carries full Data Action request *and* response payloads well past the documented cap, so
that augmentation stays **optional**. This reverses an earlier reading of this gate, which was
based on a sample whose largest response (526 chars) never approached the limit and which was
generated by a Guide rather than an AVA.

Completeness on the 6 real tool invocations: 6/6 had name, start and end, so latency is derivable
for all; 6/6 had captured input fields; 5/6 had a captured output payload.

Still open: where the ceiling actually is. 1,732 characters is the largest response these AVAs
happen to produce, not a measured limit, and one tool had no output payload at all. A deliberately
oversized payload - Deliverable C - is still needed to find the real boundary and see how
truncation is represented when it does occur.

---

## VALIDATION 12 - reconciliation proves no silent loss - PASS, and it found loss

Reproduce:

```powershell
# bceacc0b = DO - Agentic Intent Detection, confirmed to invoke an AVA.
# Rebuild the registry first; the AVA flag drifts (see gate 9).
powershell -File .\scripts\gc-build-ava-registry.ps1
python harness\drive_bot_flow.py --flow-id 0587849e-c3db-5db6-ae3e-5863c6107463 --sessions 4
powershell -File %USERPROFILE%\.cursor\skills\aws\scripts\aws-exec.ps1 -Region eu-central-1 `
  -Run "%USERPROFILE%\.cursor\skills\aws\.venv\Scripts\python.exe harness\reconcile.py --latest-batch"
```

### Measurements

| Run | Flow | Invokes an AVA? | Driven | Notified |
|---|---|---|---:|---:|
| Single interactive session | G Rail FAQ | no | 1 | 1 |
| Burst, 4 concurrent | G Rail FAQ | no | 12 | 1 |
| Spaced, ~95s apart | G Rail FAQ | no | 3 | 0 |
| After a concrete flow-id subscription | G Rail FAQ | no | 6 | 0 |
| **Corrected test** | **Agentic Intent Detection** | **yes** | **4** | **4** |

> [!IMPORTANT]
> **The 2-of-24 loss figure is withdrawn.** Every run in the first four rows used
> `DO - G Rail FAQ Agent` (`c9f5f500-...`), which does not invoke an AVA. Its recovered artifacts
> contain `actionCallGuide` and **zero** `actionCallAgenticVirtualAgent` nodes, and its
> `agenticVirtualAgentEnabled` flag was present when the registry was built in the morning and
> absent by the afternoon - the flow was reconfigured mid-test.
>
> Repeating the test on `DO - Agentic Intent Detection` (`bceacc0b-...`), which does invoke an
> AVA, gave **4 of 4 delivered, 4 of 4 retained by the platform, 100%**. Delivery is reliable.
>
> This is why the gate is worth having: the reconciler produced both the alarming number and the
> correction, from the same command. What it could not do was tell me the flow was wrong - that
> came from the person who knew the flow.

Independently, ambient traffic from 6 other flows arrived during the same window - 30 events on the
bus in total, across `digitalbot`, `inboundshortmessage` and `workflow` types - all processed
without error. That corroborates that delivery works in normal operation and is not peculiar to
the textbot driver.

### Why the wrong flow was used, and what would have caught it sooner

The flow was selected from `artifacts/ava-flow-registry.json`, which is built from
`agenticVirtualAgentEnabled` on the flow object. That flag *was* true for it when the registry was
built. So the selection was defensible at the time and still wrong, which is the interesting part:

- **The registry went stale within hours, in both directions.** Rebuilt in the afternoon, the count
  fell from 59 to 58 and this flow dropped out. A later rebuild returned it to 59 - a newly
  published AVA flow (`DO - Retail AVA`) that had not existed at the earlier rebuilds. So the
  registry drifts by flags changing on existing flows *and* by flows appearing, and a flow absent
  from it is not evidence that it is not an AVA flow. The caveat already recorded under gate 9 -
  "rebuild the registry before each collection window" - turns out to be a live operational hazard,
  not a footnote.
- **A flag on the flow is a statement about configuration, not about behaviour.** The cheap check
  that would have caught this is a content check on the artifact: does it contain
  `actionCallAgenticVirtualAgent`? Both G Rail artifacts answer no. That check costs one recovered
  artifact and is now part of the coverage scan.

### Architecture impact

1. **Reconciliation stays as designed - a safety net.** It is not being promoted to the primary
   integrity mechanism, because delivery on a correctly configured AVA flow was complete.
2. **The reconciliation query still needs an independent expected set.** Comparing the manifest
   against the event stream is circular. `reconcile.py` uses driven session ids; for production it
   should use conversation-based harvesting or the analytics API.
3. **Verify AVA presence from the artifact, not from the flow flag.** Any onboarding or
   collection-window check should assert on `actionCallAgenticVirtualAgent` in a sample artifact.
   The flow-level flag is a useful pre-filter and an unreliable guarantee.
4. **`recover_jobs.py` should become a scheduled component, not a manual script.** Given that it
   is the only thing that puts execution history into Bronze - no notification carries a signed
   URI - it belongs on a schedule.

---

## A second AVA flow, and a scenario that does not reach its own conclusion

Reproduce:

```powershell
python harness\drive_bot_flow.py --flow-id 56155fa0-92cd-574b-b7cf-0fafad91fd2f --turns 6 --verbose `
  --say "Hi, I want to return some jeans I ordered." --say "HM-4468120" --say "d.owens@example.com" `
  --say "I'll take it to a store then." --say "Yes, that's right."
```

`DO - Retail AVA` (`c1d914ca-...`, DIGITALBOT, `agenticVirtualAgentEnabled: true`, published version
1.0) was driven with a supplied returns scenario: return an order, give order number `HM-4468120`,
then email `d.owens@example.com`, at which point the AVA is expected to present return costs
unprompted, then accept "I'll take it to a store then" and a confirmation.

**The scenario does not complete, identically across three runs.** The AVA handles the first three
turns well - it opens as "Remi from the returns team", asks for the order number, re-asks after an
intent-only opening line, then asks for "your email address or delivery postcode". After the email
is supplied it returns two `NoOp` turns and control lands on `What would you like to do?`, which is
a parent-flow intent prompt, not the AVA. Every subsequent utterance is answered with
`Sorry. Tell me again what you would like to do.` The costs are never presented, and the flow
cannot be talked out of the loop: task phrasing, `cancel`, and `goodbye` all produce the same
reprompt, so the flow never reaches its own exit.

The transcripts are complete rather than truncated by the harness - each turn carries exactly one
`prompts.textPrompts.segments` entry, verified against the raw responses in
`artifacts/driven/botflow-session-*.json`. So the missing cost message is the flow's behaviour, not
a harness artifact.

### The retail AVA's failure, from the artifact

This was left as "cannot be determined from the conversation alone" until an execution history for
this flow finally became available - `45d2cec8-...`, flow version 1.0, from a real conversation
rather than an API-driven session. The artifact answers it outright. The AVA is
`AXL - Retail - Returns and Exchanges`, and its `verify_customer_order` tool was called with
exactly the scripted values:

```json
"input":         {"order_number": "HM-4468120", "verification_value": "d.owens@example.com"},
"successOutput": "{\"status\":404,\"error\":\"No order was found with that order number.\"}"
```

and the AVA node then terminated with:

```json
"outputData":     {"exitReason": "Error", "outputs": []},
"outputPathId":   "__FAILURE__",
"outputPathInfo": {"reason": "Reason.Internal", "reasonValue": "An internal error occurred."}
```

So the scripted order does not exist in that AVA's backing data, and the AVA did not handle the 404
- it took the `__FAILURE__` path with an internal error. Control returned to the flow's
`Wait for Input`, whose NLU prompt is the `What would you like to do?` that the conversation then
looped on. Three things follow. The costs were never going to appear, because the lookup the quote
depends on failed. The scenario was untestable as scripted rather than the AVA being wrong about
returns. And this is the first captured Data Action error, which is what moved gate 10 to 6 of 11.

It also demonstrates the value of the artifact over the transcript: from the conversation this
looked like an AVA that changes the subject, and from the artifact it is a tool 404 followed by an
unhandled internal error. That is precisely the explainability gap this architecture exists to
close.

**No explainability artifact could be obtained for it, and that is a consequence, not a separate
failure.** Because the flow never reaches its own exit, the sessions ended in a forced disconnect,
and by finding 3 those executions produce no history and no event. `/flows/instances/query` reports
`total: 0` for this flow id, 15 minutes after the last run and repeatedly since. So this flow
contributes nothing to gates 10 and 11: the AVA scenario coverage figures stay as recorded on the
bceacc0b artifacts.

The controlled comparison worth keeping: a bceacc0b session was deliberately force-disconnected
mid-question, and it too produced no history and no event, while that flow's indexed execution
count stayed at 5. Same flow, same org, different ending, opposite result. That is what identifies
the ending - not the flow, and not EventBridge - as the cause.

Getting explainability data out of this scenario needs either an AVA that runs to a flow exit, or
data the AVA can actually resolve. It is a good candidate for Deliverable C rather than a blocker
here.

---

## A third AVA, tested from its configuration rather than by guesswork

The same flow id was then republished as `DO - AVA` version 2.0, pointing at
`AXL APT Benchmark - Field Dispatch Coordinator` version 50.0, supplied as an export
(`axl-apt-benchmark---field-dispatch-coordinator-export.json`). Reading the configuration first
changed the test completely, and is the approach worth keeping.

### What the configuration gave that a conversation could not

The AVA has five Data Action tools whose simulators are all directly executable via
`POST /api/v2/integrations/actions/{actionId}/execute`. Executing them first produced the exact
dataset the AVA is working from, before saying a word to it:

| Probe | Result |
|---|---|
| `FS-70118` | Amsterdam Data Hall 4 (`SITE-AMS-04`), Platinum, `hvac_senior`, 3h job, 8h SLA |
| `FS-99999` | `ticket_found: false`, and the note says the *system is down*, not that the reference is wrong |
| access window, mon-fri | 08:00 to 18:00 CET, no escort |
| access window, saturday | 09:00 to 13:00 CET, **escort required** |
| access window, sunday | closed |
| slots, monday | 2 slots, exactly 1 bookable: `AMS-S4`, Pieter de Vries, 09:00 to 12:00 CET |
| slots, tue-fri | none |
| slots, saturday | 3 slots, **0 bookable** - one over the window, one 2h against a 3h job, one wrong skill |

The dataset is purpose-built: Monday is the only day a booking can succeed, and Saturday is the day
where the escort rule and three different rejection reasons all have to be handled at once. Knowing
that in advance is the difference between a scripted conversation that lands on the intended path
and the three wasted runs the previous flow cost.

### The happy path completes, and every stated value is verbatim from the tools

Reproduce:

```powershell
python harness\drive_bot_flow.py --flow-id 56155fa0-92cd-574b-b7cf-0fafad91fd2f --turns 5 --verbose `
  --say "Hi, it's about service ticket FS-70118." --say "Monday would suit us." `
  --say "Please book the 09:00 to 12:00 CET slot with Pieter de Vries." `
  --say "Yes, I confirm that slot." --say "That is everything, thank you. Goodbye."
```

Four tools ran in order - ticket lookup, access window, engineer slots, booking - and the
confirmation came back as "the visit has been booked with Pieter de Vries from 09:00 to 12:00 CET on
Monday. The booking reference is DSP-70118-AMSS4." A second run took the Saturday path and produced
the escort refusal, the all-slots-rejected message and an escalation to duty manager Marieke Vos
with reference `ESC-70118-NVS` and a callback "within 2 hours". Every reference, name, time and
window the AVA stated matches the simulator output exactly - checked by executing
`escalate_to_duty_manager` directly afterwards. Nothing was invented, with one exception below.

### Three defects the configuration check exposed

1. **Both external inputs are wired to empty literals.** The flow's `CallAgenticVirtualAgentAction`
   maps `site_contact_name` and `disclosure_mode` to empty strings. Nothing passed at launch can
   reach them, because the mapping is a literal rather than a flow variable. The AVA's own
   instruction for an empty name is explicit - "if that field came back empty then open with the
   site name instead and do not guess a name" - and instead it addressed the site contact as
   **"John"** in every message of all three runs. An invented customer name in a message the site
   contact is told to write into their own records is the most consequential finding here, and it is
   caused by the flow wiring rather than by the AVA's prose.
2. **`disclosure_mode` has no default and is required by the slot tool.** It is unset for the same
   reason. It did not bite on the Monday path, where the correct answer is the same under both raw
   and flagged mode, which is exactly why it would be easy to ship broken.
3. **A rule the configuration explicitly anticipates was still broken.** Instruction 10 bars
   "unfortunately" from anywhere in a message and quotes the failing phrase verbatim as an example.
   The Saturday reply was "but unfortunately none of them can be booked for this job". Also minor:
   the Monday run postponed the engineer options to a later message ("I will now check for available
   engineer slots"), which the slot tool's instructions forbid twice, and the escort refusal dropped
   the site contact's first name that every other message carried.

### The flow itself cannot produce explainability data

`DO - AVA` is a single sequence: `Wait for Input` -> `Call Agentic Virtual Agent` -> back to
`Wait for Input`. There is no exit action on any of the AVA's Success, Failure or Timeout paths. So
when the AVA finishes - and it does finish cleanly, emitting its `UserExit` message "Thanks for
contacting Northwind Field Services. Take care." - the flow returns to waiting for input and the
execution never terminates. All three sessions therefore produced no execution history and no
notification, which by finding 3 is expected rather than a delivery problem.

This is the cleanest illustration of finding 3 in the log. The AVA is well built and the
conversation reached its intended conclusion including a confirmed booking, and the pipeline still
sees nothing, purely because the flow has no exit. Any org onboarding onto this architecture needs
that checked at the flow level: an AVA whose parent flow never exits is invisible regardless of how
well the AVA performs. Adding a Disconnect or Exit Bot Flow action after the AVA node would make
these executions observable.

---

## Where AVA observability data can come from - the full inventory

Reproduce: `python harness\probe_sources.py`

The architecture was designed around one notification topic and the Jobs API. That is the right
pair, but it was never checked against the platform's own catalogue, so this is the enumeration.
242 notification topics are visible to this client, of which 157 are EventBridge-eligible and 13
relate to flows, bots or agentic virtual agents.

### Push - costs no API budget

| Topic | Carries | Verdict |
|---|---|---|
| `v2.flows.instances.flow.{id}` | `executionId`, `endpoint`, flow id/type/version, inline `execution[]` of 8 impoverished fields, `executionItemsTruncated`; **never** a signed URI | **the retrieval trigger.** The only topic naming an execution retrievably |
| `v2.detail.events.conversation.{id}.flow.end` | 24 conversation-level fields incl. `conversationId`, `sessionId`, `flowId`, `exitReason`, `disconnectType`; no `executionId`, no `endpoint` | reconciliation trigger only; delivered 6 of the 30 events seen |
| `v2.detail.events.conversation.{id}.flow.start` / `.flow.outcome` | flow lifecycle | lifecycle only |
| `v2.analytics.flow.{id}.metrics` / `.aggregates`, `v2.flows.outcomes.{id}`, `v2.flows.{id}` | 107 conversation-metric fields; no tool, turn or guardrail detail | aggregate reporting, not explainability |
| `v2.bot.conversation.{id}.conversations.summaries` | bot summaries | not AVA internals |

**No agentic or AVA-specific topic exists.** Of 242 topics, none carries tool calls, guardrail
outcomes or turn-level AVA detail. This is the structural finding behind the whole design: **push
can only ever be a trigger, never the payload.** The preference for EventBridge over polling is
still correct, but it buys notification of *what happened*, not *what the AVA did*.

### Pull, full fidelity - the only route to AVA internals

| Route | Cost | Notes |
|---|---|---|
| `POST /api/v2/flows/instances/jobs` | 2 API calls per 10 executions, downloads off-API | **the fidelity source**: turns, tool calls, `dataAction.input`, `dataAction.successOutput`, timings, exit reasons |
| `GET /api/v2/flows/instances/{instanceId}` (the `endpoint` field) | 1 execution per call | same data, creates a job; strictly worse than batching, so `endpoint` is a convenience not a route |

### Pull, index only - cheap, bulk, and it sees what push cannot

| Route | Cost | Notes |
|---|---|---|
| `/api/v2/analytics/botflows/{id}/reportingturns` | 45 turns / 7 sessions in **1 call** | per-turn `userInput`, `botPrompts`, `askAction`, `askActionResult`, `conversation.id`; 10-day retention; gains tool, knowledge, data action and guardrail metadata on 31 Aug 2026 |
| `/api/v2/analytics/botflows/{id}/sessions` | 7 sessions in **1 call** | `botResult`, `botResultCategory` (e.g. `DisconnectRequestedByUser` / `UserDisconnect`), channel, language, `conversation`, timings - session outcome classification in bulk |
| `POST /api/v2/flows/instances/query` | 1 call per page | index only; 7 criteria permitted in this org, no temporal ones; `ConversationId` is the useful one |
| Analytics conversation detail / aggregates / async jobs | bulk | conversation-level metrics, not AVA internals |

**Both analytics endpoints see the executions the pipeline is blind to.** All 7 sessions on the
test flow appear in both, including the 6 whose executions never terminated and therefore produced
no history and no notification. `botflows/{id}/sessions` is the cheapest AVA outcome signal
available anywhere - one call returns a classified outcome per session - and it had not been probed
before now.

### Outside the platform

- **Tool-boundary telemetry.** The AVA's tools here are Genesys Functions exposed as Data Actions.
  Instrumenting them emits tool inputs and outputs at zero Genesys API cost. Section 10 offers this
  as a fallback for truncation; on the evidence it is not needed for fidelity, but it is the only
  source that survives execution-history retention and it costs no API budget.
- **Architect Execution History and Replay.** The same data through a UI, for human triage.

---

## The empty URI is not waiting on next week's release

Reproduce: `python harness\probe_reporting_turns.py --flow-id <botFlowId> --days 2`

The 31 August 2026 release adds "Turn-level metadata in the Bot Flow Reporting Turns API"
(AI-1613 / `DXVBOTS-I-510`), exposing tool calls, knowledge calls, data action calls and guardrail
outcomes per virtual agent response turn. It is reasonable to wonder whether the empty
`executionHistoryUri` is simply a feature that has not shipped yet. On the evidence it is not, for
four separate reasons:

1. **Different subsystem.** `executionHistoryUri` is a field on the flow execution notification
   (`v2.flows.instances.flow.{id}`) pointing at Architect historical execution data, retrieved
   through `/api/v2/flows/instances/jobs`. AI-1613 extends
   `/api/v2/analytics/botflows/{botFlowId}/reportingturns`, which is bot flow analytics. Different
   producer, different store, different retention.
2. **The release material never mentions it.** Neither the release note nor the ticket refers to
   notification topics, EventBridge, or download URIs, and no item on the "Features coming soon"
   page for this release touches flow instance notifications or execution history retrieval.
3. **The notification's retrieval mechanism already works.** `endpoint` is populated and functional
   - a GET on it creates a Jobs job (gate 4). Only the signed-URI variant is absent, on 0 of 30
   events across 8 flows and 4 flow types. That is a field declared in the schema and never
   populated by its producer, not a field waiting on an unrelated analytics API.
4. **It moves in the opposite direction.** AI-1613 explicitly excludes full tool input and output
   payloads in favour of concise metadata. The execution history artifact already carries those
   payloads in full - `dataAction.input` and `dataAction.successOutput` up to 1,732 characters
   (gate 11). A feature designed to return strictly less detail cannot be the thing that would
   populate a link to the full trace.

### It does matter, for a different and larger reason

Baselined today on `c1d914ca-...`: 45 turns across 7 sessions, 18 distinct field names, and none of
the ten candidate metadata field names (`toolCalls`, `guardrails`, `dataAction`, `knowledgeCall` and
so on) present yet. Today each turn carries `userInput`, `botPrompts[]`, `askAction` identifying the
`CallAgenticVirtualAgentAction`, `askActionResult`, and timestamps.

The significant find is which sessions appear. **All seven are there, including all six
API-driven sessions that produced no execution history and no notification at all.** The endpoint
has full transcripts for executions that finding 3 says are structurally invisible to this
pipeline. So this API is a route into the abandoned and never-terminated population, which is the
one blind spot the architecture currently has no answer for.

Three consequences worth designing around:

- **It will supply two of the five scenarios gate 10 still cannot observe** - guardrail outcomes and
  knowledge calls - plus tool call and data action success/failure status.
- **It carries a conversation cross-link, but only for real conversations.** `conversation.id` was
  present on all 7 turns of the genuine conversation and absent on every API-driven textbot session,
  which have no conversation. For production reconciliation that is fine, since real traffic always
  has a conversation, and it is exactly the independent expected set the reconciliation gap needs.
- **It is a triage index, not a replacement for the Jobs path.** 10-day retention against execution
  history's longer window, concise metadata rather than payloads, and per the release note it
  requires a Genesys Cloud CX AI Experience subscription. The right shape is this API for finding
  which conversations to investigate, and the Jobs path for the full trace once one is chosen -
  which is what its own ticket describes it as.

Re-run the baseline script after the release to measure what actually landed.

---

## Corrections to the architecture document

Findings that contradict or refine the source document, in descending order of consequence:

1. **Sections 4, 5, 11 - there is no signed download URI.** `executionHistoryUri` and
   `executionHistoryUriTtl` are declared in the topic schema and populated on 0 of 2 delivered
   events. All retrieval is Jobs-based. The "direct download happy path with Jobs fallback"
   framing should be replaced by "Jobs is the only path; `endpoint` is its per-execution
   wrapper". Gate 5 becomes inapplicable and the TTL arithmetic becomes defensive code.
2. **Section 10 - the limits table does not bind.** Data Action responses of 1,732 characters,
   strings of 2,918 characters and collections of 253 items are stored intact against documented
   caps of 1,000 / 253 / 20. The tool-boundary telemetry offered as a fallback stays optional.
   This supersedes the earlier reading of gate 11.
3. **Section 5.3 - the query API and datetime.** The document says the query API "does not
   support querying by flow start/end datetime". The OpenAPI `CriteriaItem.key` enum does include
   `FlowStartDateTime` and `FlowEndDateTime` with `gt/gte/lt/lte`, but this org rejects them with
   `400 "Attempting to query with unallowed capabilities"`, and
   `GET /flows/instances/querycapabilities` lists only 7 permitted criteria, none temporal. The
   statement is **correct in effect for this org**, but the reason matters: the spec enum is a
   global superset and per-org capability gating is authoritative. Onboarding must read
   `querycapabilities`, not the spec.
4. **Section 5.3 - the query API is more useful than "last-resort" implies.** The permitted
   criteria include `ConversationId`, so walking recent conversations from the analytics API and
   resolving each to its flow executions is an effective harvesting path. This found 191
   executions across 60 conversations, 27 on AVA flows, and unblocked gates 2, 3, 10 and 11 before
   any event arrived. Unsuitable as the primary mechanism at volume, but the right tool for
   backfill, onboarding, and now for reconciliation's expected set.
5. **`agenticVirtualAgentEnabled` is a drifting pre-filter, not a guarantee.** It changed on a
   live flow within hours during validation. Confirm AVA presence from
   `actionCallAgenticVirtualAgent` in a recovered artifact.
6. **Sections 1 and 4 - `executionItemsTruncated` is not the binding constraint.** Inline
   `execution[]` items carry only `objectType`, `objectId`, `outputPathId`, `executionId`,
   `startDateTime`, `error`, `warning`, `languageTag`. No inputs, outputs, status, latency or end
   time. Confirmed again on both delivered events, which carried 8 and 7 inline items with
   `executionItemsTruncated: false`. The item schema itself is the limit, so downloading the
   history is mandatory rather than an optimisation.
7. **Section 11 gate 8 - schema presence is not field population.** A readiness check that
   asserts against the topic schema passes on an org where the primary retrieval mechanism is
   unavailable. Onboarding must assert against a captured event.
8. **Abandoned executions are outside the pipeline's reach entirely.** The document treats the
   event stream as covering flow executions, with reconciliation as the guard against delivery
   loss. An execution that never reaches its flow's exit produces no history, so no event, so
   nothing for reconciliation to find either - it is invisible to both mechanisms rather than lost
   by one. This matters most for the abandonment analysis the architecture is partly meant to
   support: the conversations most worth explaining are the ones that ended badly. Any coverage
   claim should be scoped to completed executions, and measuring the abandoned population needs a
   different source, most plausibly conversation analytics. The same mechanism has a flow-design
   face that onboarding must check: a bot flow whose AVA paths loop back to `Wait for Input` with no
   exit action never terminates, so a perfectly healthy AVA on it emits nothing. Measured on
   `DO - AVA`, where a conversation that ran four tools and confirmed a booking produced no record.
9. **A Data Action simulator can be executed directly, which makes AVA testing deterministic.**
   `POST /api/v2/integrations/actions/{actionId}/execute` returns exactly what the AVA's tool will
   return. Reading an AVA's configuration and executing its tools before driving a conversation
   turns scenario design from guesswork into a lookup, and it is what distinguishes an AVA defect
   from test data that never matched. This belongs in the onboarding runbook.

---

## Reporting Turns re-baseline, 26 October 2026 - PASS, and now swept server-side

Reproduce: `python harness\probe_turn_metadata.py --flow-id <botFlowId> --days 2` (prints field
paths, counts and enum values only, never content).

One synthetic session was driven on the FS-70118 flow with the documented Monday script. It called
four tools and, like every session on that flow, never reached the flow's exit, so it has no
execution history and emitted no notification. Reporting Turns returned all of it:

| Measured | Result |
|---|---|
| turns returned | 6 of 6 |
| `toolCalls[]` | 4 of 4 calls, each with `toolName`, `toolType` (`DataAction`), `toolId`, `targetId`, `status` (`Success`), `origin` (`AvaTool`), `latencyMs`, `dateInvoked` |
| `askAction.agentDetails` | `agentId`, `agentName`, `agentVersion` on every AVA turn |
| `executionFrameId`, `botFlowInvocationEvents[].type` | present |
| declared but not yet observed | `sessionEndDetails`, `ReportingTurnGuardrailEvent`, `ReportingTurnKnowledgeMetadata`, `askActionResult = GuardrailsViolation` - this flow has no guardrail or knowledge tool, and the session never ended |
| tool inputs and outputs | **absent** - still exclusive to execution history |

This reverses the reason the web app dropped Reporting Turns on 2 September: the endpoint now
proves which tools ran, in which turn, with what outcome, for sessions the Jobs path can never see.

It is now persisted without a browser. `infra/aws/turns.tf` adds an hourly EventBridge schedule
running `collector/turns_sweep.py`, which lists every flow with `agenticVirtualAgentEnabled`, reads
`divisions/reportingturns` from a per-flow watermark minus a two-hour overlap, writes raw pages to
`bronze/turns/` and merges turns per session into DynamoDB `ava-explain-turns`. A flow's
watermark advances only when its pages were read to the end. First run, backfilling the ~10 day
retention window: 68 flows swept, 0 failed, one Reporting Turns page per flow plus the flow listing, 14 turns
in 3 sessions, 4 tool calls.

The same apply upgraded the EventBridge collector to inline Jobs retrieval at 10 ids per job
(SQS batch 5 -> 10) with credentials from Secrets Manager `ava-explain/genesys-oauth`, so
execution history no longer depends on running `recover_jobs.py` by hand.

## Remaining work

| Item | Why it is still open |
|---|---|
| Deliverable C - purpose-built test AVA | still the largest gap: 5 of 11 scenarios unobserved - Data Action timeout, AVA guardrail block, knowledge lookup, AVA containment, voice - and the real truncation ceiling is unknown; the sweep is ready to record guardrail and knowledge metadata the moment such a session runs |
| Add a flow-exit check to onboarding | an AVA whose parent flow loops back to `Wait for Input` with no exit action produces no history at all; the turn sweep now records those sessions, but without tool inputs and outputs |
| Replace the sweep and collector OAuth client with a least-privilege one | `ava-explain/genesys-oauth` currently holds the harness client, which has far more permission than flow listing, Reporting Turns and Jobs need |
| Seed `RECOVERY_REQUIRED` rows from reconciliation | the manual path now exists (`recover_jobs.py --execution-id`); wiring reconciliation's output into it automatically does not |
| Establish the rate-limit domain under load | no `inin-ratelimit-*` headers were returned on the endpoints probed, so sustainable throughput is still un-measured |
| Gate 7 under deliberate fault injection | duplicates and ordering will not appear from volume alone |
| Voice AVA coverage | no voice execution captured; `FelixVoiceBotFlow` and `NN Insurance Voice Bot` are candidates |
| Reconcile against genuine conversation traffic | driven sessions bypass the inbound flow; worth confirming parity |
