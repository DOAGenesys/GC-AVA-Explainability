# GC AVA Explainability

Explainability and observability for Genesys Cloud Agentic Virtual Agents: understanding not just
what an AVA concluded, but what it tried, what came back, and why it went the way it did.

The repository contains two things — a **product**, and the **evidence** that shaped it.

| | |
|---|---|
| **[`web/`](web/README.md)** | **The application.** A Next.js workspace that captures selected AVA flow executions in real time and retrieves full traces through the batched Jobs API. |
| [`docs/validation-log.md`](docs/validation-log.md) | The measurement record. Every claim the application relies on, with the probe that established it. |
| [`genesys-cloud-ava-explainability-at-scale-architecture.md`](genesys-cloud-ava-explainability-at-scale-architecture.md) | The original event-driven architecture, and where reality diverged from it. |
| `collector/`, `infra/` | An AWS EventBridge → SQS → Lambda → S3 prototype. Superseded, retained as evidence. |
| `harness/` | Python probes used to measure the platform ([`harness/README.md`](harness/README.md)). |

**Start at [`web/README.md`](web/README.md)** for what the product does and how to run it.

## What was learned

The project began as an event-driven pipeline: subscribe to flow execution notifications over
EventBridge, download the execution history each notification points at, archive it. Measuring the
platform rather than assuming it produced three findings that reshaped the design.

**Notifications carry the retrieval pointer, not AVA content.** Of 242 notification topics visible
in the validated org, none carries tool calls, guardrail outcomes or turn detail. However,
`v2.flows.instances.flow.{id}` reliably supplies `executionId`, `flowId` and `conversationId`.
That is enough to eliminate discovery and submit the execution directly to the Jobs API.

**Execution history batches, and batching is worth 10x.** A job accepts **10** execution ids (11 is
a hard `422`), costs **2 API calls**, and returns a download URI per entity served from a host that
is not the Platform API — so the payload bytes do not consume the API allowance. That is **0.2 API
calls per execution**. This overturned a documented assumption in this repository that batched jobs
returned no download URI, which had made the collector ten times more expensive than necessary.

**Execution history does not cover every conversation.** History is written only when an execution
reaches its flow's exit. Abandoned conversations, and flows with no exit path after the AVA
responds, produce a session and a transcript but no execution history at all — and the Jobs API
answers 404 for those ids **permanently**, not transiently. On the flow used for validation, that
was **6 of 7 sessions**.

The current application therefore uses the notification as a zero-discovery trigger and batches
the supplied execution IDs ten at a time for full-history retrieval. The trade-off is explicit:
interactive WebSocket capture observes selected flows only while the browser page remains open.

## Validation environment

| | |
|---|---|
| Genesys org | `<GENESYS_ORG_NAME>` / `<GENESYS_ORG_ID>` |
| Genesys region | `prod-euc1` (Frankfurt), API `https://api.mypurecloud.de` |
| AWS account / region | `123456789012` / `eu-central-1` (prototype only) |

Genesys credentials are read at run time from the MCP config and never enter this repository. AWS
credentials are resolved by the `aws` skill and never enter the repository, the shell, or Terraform
variables.

## The superseded prototype

`collector/` and `infra/` implement the original architecture: a Genesys EventBridge integration, a
partner event bus, SQS with a dead-letter queue, a collector Lambda writing to a versioned S3
Bronze bucket and a DynamoDB manifest, with alarms and cost controls. It works, and the validation
gates were answered against it.

It is retained because the evidence behind every finding above was collected through it, and
because the runbook and the gate record are only meaningful alongside the code they describe. It is
not the recommended deployment path.

> [!IMPORTANT]
> Standing the prototype back up opens an org-wide firehose. The notification topic's `{id}` is not
> parameterised, so every Architect flow execution in the shared presales org is delivered to AWS.
> AWS-side rules control what is *stored*, not what *arrives*.
>
> What it does not do is change what Genesys records. Execution-data storage has been enabled
> org-wide at level `All` since 2024, independently of this project.
