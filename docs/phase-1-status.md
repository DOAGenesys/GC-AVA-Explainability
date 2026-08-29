# Phase 1 status - what is built, what is proven, what remains

**Updated:** 2026-08-27
**Supersedes:** the "what is still needed" section of [phase-0-assessment.md](phase-0-assessment.md)

---

## 1. Position in one paragraph

Everything that can be built or proven without delivering events is done. Both Terraform
stacks are written and validated, the collector Lambda is written, the validation harness is
written and smoke-tested, and two of the twelve Section 11 gates are closed with live evidence.
The Genesys prerequisites in Section 3 of the architecture turned out to be already satisfied
org-wide, and the OAuth permission gaps recorded in Phase 0 have been closed. Exactly one step
now stands between here and eight further gates: **creating the Genesys EventBridge integration,
which is a write to a shared production org and is therefore the user's decision, not mine.**

---

## 2. Resolved since Phase 0

| Phase 0 blocker | Position now |
|---|---|
| OAuth client missing 14 permissions | Closed. Client holds `Master Admin`; every previously-403 operation verified working |
| Execution-data storage must be enabled org-wide | Already enabled since 2024-05-13. No change needed |
| Org default log level must not be raised | Already `All` since 2023-10-06. No change needed |
| Per-flow log level override availability unknown | Moot. The org default is already the level we need |
| AWS account, region, credentials | Done. Account `123456789012`, assume-role hardened, verified |
| Terraform cost controls declared but unimplemented | Implemented: discovery-logging toggle, PITR toggle, budget, anomaly monitor |
| Validation 9 filter strategy unknown | Solved with hard numbers. See below |

### The Section 3 finding is the significant one

The architecture treats enabling historical execution data as mandatory work with unavoidable
org-wide side effects, and Phase 0 flagged that as a governance problem in a shared org. It is
already on, at level `All`, org-wide, and has been for over two years.

This changes the character of the remaining governance question. We are not proposing to make
Genesys *record* more data about other people's flows. It already records everything at full
detail for all 631 flows. The only question left is whether notifications about those
executions are *delivered* to our AWS account.

---

## 3. Gates closed with live evidence

Full detail in [validation-log.md](validation-log.md).

**Validation 8 - topic and schema: PASS.** `v2.flows.instances.flow.{id}` carries the
`EventBridge` transport (157 of 242 topics do), and all five decisive schema fields are present.
`executionHistoryUriTtl` is an integer in seconds, so expiry is computable rather than
observed.

**Validation 9 - identifying AVA flows: PASS, with a better answer than the gate anticipated.**
The flow object publishes `agenticVirtualAgentEnabled`, so the set of flows that can contain an
AVA is knowable from one paged metadata read. In this org, 59 of 631 flows, which is 20.1% of
the 294 bot-like flows. Filtering the EventBridge rule on those flow ids avoids downloading
roughly 80% of bot-flow execution histories with no loss of fidelity.

**Validation 2 - expand vocabulary: partial.** The supported values are `bots` and
`dataActions`, read from the live OpenAPI definition. Both are directly relevant to AVA
explainability. Note they are plural: `bot` and `dataAction` would both be rejected, which is
why the harness reads the vocabulary at runtime rather than carrying a list.

---

## 4. Built and validated, not yet deployed

| Component | State |
|---|---|
| `infra/genesys/` | `terraform validate` passes. Creates the `amazon-eventbridge-source` integration |
| `infra/aws/` | `terraform validate` passes. Bus, rules, SQS + DLQ, Lambda, S3 Bronze, DynamoDB manifest, alarms, budget, anomaly monitor |
| `collector/handler.py` | Compiles. Writes envelope, manifest row, downloaded history and a download probe record |
| `harness/` | 6 scripts, all compile and run. Cover gates 1-6 |
| `scripts/` | 9 probes. Cover gates 8-9 and org readiness |

### Region: eu-central-1

The org's habitat is `prod-euc1` (Frankfurt) and the events carry EU conversation content, so
the collector runs in `eu-central-1` to keep the data in-region and avoid a cross-border hop.
The tfvars examples previously said `eu-west-1`; both stacks now say `eu-central-1`. These two
values must match, or the partner event source will not be found.

Note this is independent of `AWS_REGION` in the credential file, which only decides where STS
is called. Passing `-Region eu-central-1` to the wrapper, or setting `aws_region` in tfvars, is
what places the resources.

### Cost shape

The dominant line is not a resource, it is the firehose: `enable_discovery_logging` ingests
100% of org-wide events into CloudWatch Logs at $0.50/GB. It defaults to on because it is the
only way to confirm the real `detail-type` shape, and should be turned off as soon as that is
confirmed. A $10 monthly budget and a Cost Anomaly monitor are created by the stack; add an
address to `budget_alert_emails` or they are created but silent.

---

## 5. The one remaining decision

Deploying the AWS stack requires the partner event source to exist, and that only appears once
the Genesys integration is created and enabled. So the sequence is fixed:

```text
1. apply infra/genesys   (ENABLED)          <- write to the shared org
2. scripts\wait-for-partner-source.ps1      (Genesys takes a few minutes)
3. apply infra/aws
4. capture events, then run the harness      <- unblocks gates 1, 3, 4, 5, 6, 7
```

Step 1 needs an explicit decision because of what it does, which is narrower than Phase 0
assessed but still real:

- **It is additive and reversible.** A new integration with its own suffix. It does not touch
  the existing third-party `AVA Monitoring` pipeline pointing at account `640005036677`, and
  deleting it stops all delivery.
- **Delivery is org-wide.** `{id}` is not parameterised, so every flow execution in the org
  arrives, from all authors and all demos. AWS-side rules control what is *stored*, never what
  *arrives*. The 59-flow filter reduces storage and downloads, not delivery.
- **It is EU conversation data leaving the org.** The org records at level `All`, so payloads
  include Data Action inputs and outputs. Mitigations already in the stack: `eu-central-1`,
  30-day Bronze expiry, 7-day log retention, no public access, encryption at rest, and signed
  URIs redacted in every evidence artifact.
- **Volume is unmeasured.** 631 flows in an active presales org, and nobody has counted daily
  executions. This is what the budget and anomaly monitor are for.

### Deliverable C is still outstanding

Gates 10 and 11 need an AVA that can produce a Data Action timeout, a guardrail block, and
oversized payloads on demand. Ambient traffic cannot be made to fail on cue. The permissions to
build one now exist (`Master Admin`), but it is a separate build and should follow once the
pipeline is proven end to end on real traffic.
