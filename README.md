# GC AVA Explainability

Explainability and observability for Genesys Cloud Agentic Virtual Agents: understanding not just
what an AVA concluded, but what it tried, what came back, and why it went the way it did.

The repository contains two things — a **product**, and the **evidence** that shaped it.

| | |
|---|---|
| **[`web/`](web/README.md)** | **The application.** A Next.js workspace that captures selected AVA flow executions in real time and retrieves full traces through the batched Jobs API. |
| [`docs/validation-log.md`](docs/validation-log.md) | The measurement record. Every claim the application relies on, with the probe that established it. |
| [`genesys-cloud-ava-explainability-at-scale-architecture.md`](genesys-cloud-ava-explainability-at-scale-architecture.md) | The original event-driven architecture, and where reality diverged from it. |
| `collector/`, `infra/` | The always-on AWS backend: an EventBridge → SQS → Lambda collector that archives execution history through Jobs, and an hourly Reporting Turns sweep that persists every AVA session, which the web app reads through Vercel OIDC. |
| `harness/` | Python probes used to measure the platform ([`harness/README.md`](harness/README.md)). |

## Architecture at a glance

[![AVA Explainability technical architecture: Genesys Cloud pushes flow-execution events through an EventBridge partner bus, SQS and a collector Lambda that retrieves full execution history via the Jobs API into S3 and a DynamoDB manifest; an hourly sweep Lambda stores Reporting Turns tool usage in DynamoDB; the Next.js web app on Vercel reads both through Vercel OIDC and also captures live via Notifications WebSocket and on-demand Jobs.](docs/images/ava-explainability-architecture.jpg)](docs/images/ava-explainability-architecture.jpg)

Two complementary paths. The **real-time path** turns each `v2.flows.instances.flow.{id}` event
into a Jobs API retrieval of the full execution history, including tool inputs and outputs. That
history exists only when the bot flow reaches an exit. The **hourly path** sweeps Reporting Turns,
which records the tool calls on every AVA turn, including sessions that never exit, for about 10
days. The resources are described in [The AWS backend](#the-aws-backend) and
[`web/README.md`](web/README.md).

**Start at [`web/README.md`](web/README.md)** for what the product does and how to run it.

## What was learned

The project began as an event-driven pipeline: subscribe to flow execution notifications over
EventBridge, download the execution history each notification points at, archive it. Measuring the
platform rather than assuming it produced three findings that reshaped the design.

**Notifications carry the retrieval pointer, not AVA content.** Of 257 notification topics in the
validated org, 201 are deliverable over EventBridge, and none carries tool calls, guardrail outcomes
or turn detail. `executionHistoryUri` is declared in the schema but was absent even on an AVA
execution that reached its flow exit. However, `v2.flows.instances.flow.{id}` reliably supplies
`executionId`, `flowId` and, for executions inside a conversation, `conversationId` (sessions driven
through the bot-flow sessions API have none). That is enough to eliminate discovery and submit the
execution directly to the Jobs API.

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

**Reporting Turns now covers what execution history cannot.** Since the September and October 2026
releases, each AVA turn in the Bot Flow Reporting Turns API carries its tool calls (name, type,
status, latency) and the AVA's name and version. Measured on a session that never exited: all 6
turns and all 4 tool calls were returned. Tool inputs and outputs remain exclusive to execution
history, and retention is about 10 days.

The application therefore uses the notification as a zero-discovery trigger and batches the
supplied execution IDs ten at a time for full-history retrieval. Interactive WebSocket capture
observes selected flows only while the browser page remains open, so the AWS stack provides the
persistent, server-to-server path: the EventBridge collector archives every execution history, and
an hourly sweep stores every AVA session's turns and tool outcomes before retention drops them.

## Validation environment

| | |
|---|---|
| Genesys org | `<GENESYS_ORG_NAME>` / `<GENESYS_ORG_ID>` |
| Genesys region | `prod-euc1` (Frankfurt), API `https://api.mypurecloud.de` |
| AWS account / region | `123456789012` / `eu-central-1` |

Genesys credentials are read at run time from the MCP config and never enter this repository. AWS
credentials are resolved by the `aws` skill and never enter the repository, the shell, or Terraform
variables.

## The AWS backend

`collector/` and `infra/` implement the server-to-server side: a Genesys EventBridge integration, a
partner event bus, SQS with a dead-letter queue, and a collector Lambda that retrieves execution
history through Jobs (ten ids per job) into a versioned S3 Bronze bucket and a DynamoDB manifest,
with alarms and cost controls. The validation gates were answered against it.

`infra/aws/turns.tf` adds the Reporting Turns sweep (`collector/turns_sweep.py`): hourly, per AVA
flow, from a watermark, into `bronze/turns/` and the `ava-explain-turns` table, plus the Vercel
OIDC provider and the read-only role the web app assumes. Genesys client credentials live in
Secrets Manager (`ava-explain/genesys-oauth`), written by `scripts/push-genesys-credentials-to-aws.py`,
which prints only lengths and the ARN. Collector tests: `python -m unittest discover -s collector/tests`.

> [!IMPORTANT]
> The EventBridge collector receives an org-wide firehose. The notification topic's `{id}` is not
> parameterised, so every Architect flow execution in the shared presales org is delivered to AWS.
> AWS-side rules control what is *stored*, not what *arrives*.
>
> What it does not do is change what Genesys records. Execution-data storage has been enabled
> org-wide at level `All` since 2024, independently of this project.
