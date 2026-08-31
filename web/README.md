# AVA Observability

Explainability and observability dashboards for Genesys Cloud Agentic Virtual Agents.

A Next.js app on Vercel that pulls AVA activity out of Genesys on a schedule, stores it in
Postgres, and presents it as dashboards that answer two different kinds of question: _what is my
virtual agent doing across all conversations_, and _what exactly happened in this one_.

It is built around a constraint that most observability tooling gets wrong: Genesys does not hold a
complete record of every AVA conversation. This app is explicit about which conversations it can
explain in full and which it can only summarise, rather than quietly presenting partial data as
though it were complete.

---

# Part 1 — What it does

## The problem

An Agentic Virtual Agent decides things. It chooses which tool to call, with which arguments, and
what to do with the result. When a conversation goes wrong, the useful question is never "what was
the outcome" — it is "what did the agent believe, what did it try, and what came back".

Genesys exposes that information, but across three different APIs with different shapes, different
retention windows, and different coverage. One of them is expensive enough that naive use will eat
an org's API allowance. Another discards its data after ten days. None of them, on its own, gives a
complete picture.

This app consolidates them into one archive and one interface.

## Who it is for

| Role                       | What they come here for                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Conversation designer**  | Why an AVA took the path it did; which tools it reaches for; where it gets stuck.                          |
| **Support / ops engineer** | A specific customer's conversation, reconstructed end to end, including the exact payload a tool returned. |
| **Platform owner**         | Whether tool integrations are healthy, and what observability is costing in API load.                      |
| **Solution consultant**    | Demonstrable evidence of what an AVA did during a POC, beyond a transcript.                                |

## The questions it answers

- What proportion of conversations does the AVA handle without a human?
- Which tools does it call, how often, and how often do they fail?
- When a tool fails, what did the agent send and what came back?
- How long do tool calls take, and which one is the slow one?
- For this specific conversation: what did the customer say, what did the agent reply, and what did
  it do in between?
- How much of what the AVA did can I actually see — and what am I blind to?
- What is all of this costing in Genesys API calls?

## The views

### Dashboard

The seven-day picture: session volume, containment rate, turns captured, how many conversations
have a full trace, tool call volume with failures called out, and the live API cost per execution.
If any conversations are permanently unexplainable, it says so at the top with a link to Coverage
rather than leaving you to infer it from a gap between two numbers.

### Tool performance

The view only full execution history can produce. Call volume and failure counts per data action,
median and 95th-percentile latency, and a health verdict per tool.

"Failure" here means the call took its **failure output path** — what the agent actually
experienced — rather than whether the underlying HTTP request looked healthy. A tool returning a
clean `200` with an empty result set still sends the agent down the failure branch, and that is the
thing worth knowing.

### Sessions

Every session in the window, newest first, each marked with its fidelity: **Full trace**,
**Analytics only**, or **Pending**. The marking is deliberate — a session list that silently omitted
the conversations without traces would misrepresent both the volume and the outcome mix.

### Session detail

One conversation, explained from both sources at once:

- **Transcript** — the turn-by-turn exchange, captured from bot flow analytics before the platform
  discards it at ten days.
- **Execution trace** — the ordered timeline of what the flow did, with each tool call expanded to
  show the inputs the agent chose and the outputs it received, the output path taken and why, and
  the elapsed time between steps.

When there is no trace, the page says which of the two reasons applies — not yet retrieved, or
never going to exist — instead of rendering an empty panel.

### Coverage

The honesty page. What proportion of sessions have a transcript, what proportion have a full trace,
and where the shortfall falls by outcome category. It exists because a tool-call chart drawn only
from the conversations that happen to have traces is a biased sample, and the bias is not random:
abandoned conversations are exactly the ones that lose their trace.

It also distinguishes _confirmed_ absence — an execution the Jobs API actually answered 404 for —
from merely unresolved work, and suggests what to do about each pattern.

### API budget

Per-run API call counts and the measured calls-per-execution ratio over time. This is a first-class
view rather than plumbing, because the whole design rests on a measured number and a number nobody
watches is a number that quietly stops being true.

## A worked example

A customer complains that the agent said their order could not be found.

1. **Sessions** → filter by time → open the session.
2. The **transcript** shows the customer gave an order number and the agent apologised.
3. The **execution trace** shows an `Order Lookup` tool call marked _Failure path_, with the inputs
   the agent chose — revealing it passed the order number with a prefix the customer never said.
4. **Tool performance** shows the same tool at a 30% failure rate across the week, so this is
   systemic rather than a one-off.

The transcript alone would have shown an unhelpful agent. The trace shows a malformed argument, and
the aggregate shows how widespread it is.

## What it deliberately does not do

- **It does not modify anything in Genesys.** Every call is a read.
- **It does not claim completeness it cannot deliver.** Coverage gaps are surfaced, not smoothed.
- **It does not replace Architect's execution history viewer** for single-flow debugging. It adds
  the cross-conversation, cross-flow, durable-archive view that Architect does not offer.
- **It does not stream in real time.** Ingestion is on a ten-minute cadence, which is a deliberate
  cost trade-off explained below.

---

# Part 2 — How it works

## Three findings that drive every design decision

These came from measuring the platform directly. Each has a cheaper-looking alternative that does
not work, so they are worth understanding before changing anything.

### 1. Notifications cannot carry AVA content, so this app polls

Of the 242 notification topics visible in the validated org, 13 relate to flows or bots and **none**
carries tool calls, guardrail outcomes or turn detail. The only topic that names an execution
retrievably, `v2.flows.instances.flow.{id}`, has an `executionHistoryUri` field that was populated
**0 times out of 30** observed events.

Push can therefore only ever be a trigger, never a payload. An event-driven pipeline would still
have to call the Jobs API for every execution — it gains latency, not efficiency, and it costs a
whole delivery infrastructure to get it.

### 2. Execution history is the only source of AVA internals, and it batches

| Measured                                     | Value                                                    |
| -------------------------------------------- | -------------------------------------------------------- |
| Execution ids accepted per job               | **10** (11 is a hard `422`)                              |
| API calls per job                            | **2** (the POST, plus one poll to `Success`)             |
| `downloadUri` on entities of a _batched_ job | **present, one per entity**                              |
| Host serving the payload                     | `api-downloads.<region>` — **not** the Platform API host |

So retrieval costs **0.2 API calls per execution**, and the payload bytes do not consume the API
allowance at all. One job per execution — the obvious implementation, and the one an earlier
version of this system used — costs ten times as much for identical data.

A rejected batch returns a bare `422` naming no id, so a rejection is **bisected** to isolate the
offending execution. Treating rejection as "none of these are retrievable" is indistinguishable
from catastrophic data loss; during validation that exact mistake produced a "0 of 15 retained"
reading against a platform that held all fifteen.

### 3. Execution history does not cover every conversation, and never will

History is only written when an execution reaches its flow's exit. A conversation the customer
abandoned — or one whose flow has no exit path after the AVA responds — produces a session and a
transcript but **no execution history at all**, and the Jobs API answers **404 permanently**, not
transiently, for those ids.

On the flow this was validated against, that was **6 of 7 sessions**.

This is why the cheap analytics endpoints are the coverage spine and execution history is the
fidelity layer on top, rather than the other way round. It is also why `NO_HISTORY` is a terminal
state in the schema: re-asking costs API budget to learn nothing.

## Data sources

| Source                                   | Cost                         | Retention   | Gives                                                                                    |
| ---------------------------------------- | ---------------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| `analytics/botflows/{id}/sessions`       | 1 call per flow per window   | Long        | Classified outcome per session. The cheapest AVA signal that exists.                     |
| `analytics/botflows/{id}/reportingturns` | 1 call per flow per window   | **10 days** | Per-turn transcript. Gains tool/knowledge/guardrail metadata on 31 Aug 2026.             |
| `flows/instances/query`                  | 1 call per ~50 conversations | —           | Discovery: conversation id → execution id.                                               |
| `flows/instances/jobs`                   | 2 calls per 10 executions    | ~10 days    | **Full AVA internals**: ordered actions, tool inputs and outputs, output paths, timings. |

Deliberately unused: `GET /flows/instances/{id}`. It creates a job internally, so it costs a job
while carrying a single execution — strictly worse than batching.

## Ingestion

Three cron passes, in dependency order, each recording its own API cost.

```
registry  (every 6h)   /flows                    → which flows are AVA-enabled
                                                          │
triage    (every 10m)  /botflows/{id}/sessions    ────────┤ 2 calls per flow
                       /botflows/{id}/reportingturns      │
                                                          ▼
                                                  conversation ids
                                                          │
fidelity  (every 10m,  /flows/instances/query     ────────┤ ~1 call per 50
           offset 5m)                                     ▼
                                                  execution ids
                                                          │
                       /flows/instances/jobs      ────────┤ 2 calls per 10
                       api-downloads.<region>             ▼ (free)
                                                  full traces → Postgres
```

**Why three passes rather than one.** They have genuinely different cost profiles and failure
modes. The registry pass is a handful of calls every few hours. Triage is cheap and must run often,
because reporting-turn data is discarded upstream after ten days and it is the only source that
sees conversations execution history cannot. Fidelity is the expensive one.

**Why fidelity is downstream of triage.** It never discovers work itself. Triage answers "what
happened" cheaply in bulk, and the expensive per-execution path only ever runs against a known
worklist. Nothing in this system polls to find out whether anything happened.

**Why the registry refreshes on a schedule.** The `agenticVirtualAgentEnabled` flag was observed
changing within a single day as flows were published. A static list silently stops covering flows
that became AVA-enabled after deployment, so the registry records _when_ the flag last changed,
making drift visible rather than invisible.

**Why the lookback overlaps the cadence.** The window is 30 minutes against a 10-minute schedule.
Reporting-turn data appears with some lag, and a window that exactly matched the schedule would
lose whatever landed a second late. Every write is an upsert, so the overlap is free.

## Data model

Six tables. The important structural decision: sessions and turns are **not** children of
executions. They are peers, joined by conversation id, so the schema can represent a conversation
that analytics can see but execution history cannot.

| Table            | Holds                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `ava_flows`      | Flow registry with the AVA flag and when it last changed.                                        |
| `ava_sessions`   | One row per session with its classified outcome. The coverage spine.                             |
| `ava_turns`      | Per-turn transcript, plus the raw entity so new upstream fields land without a migration.        |
| `ava_executions` | Full trace as JSONB, plus a `retrieval_status` of `ARCHIVED`, `NO_HISTORY` or `DOWNLOAD_FAILED`. |
| `ava_tool_calls` | Tool calls flattened out of the trace so dashboards need not open every blob.                    |
| `ingest_runs`    | Per-pass API cost accounting.                                                                    |

Two details worth knowing:

- `ava_turns.raw` stores the whole upstream entity alongside the parsed columns. The turn-level
  metadata fields ship on 31 Aug 2026, and because retention is only ten days, anything not
  captured before then is lost permanently. Storing the raw entity means those fields appear in the
  archive the day they ship, with no migration and no gap.
- `upsert_execution` never overwrites a good trace with a null from a later failed attempt, and
  increments a retry counter rather than resetting it.

## Authentication and security

Two Genesys identities, deliberately separate.

**Interactive — Authorization Code with PKCE.** The app holds no interactive credentials of its
own; the user supplies their region and OAuth client id at sign-in, and everything they see is read
with their own token and their own permissions. Access and refresh tokens live only inside an
AES-256-GCM encrypted, HttpOnly cookie — never in storage, never server-side. The app session is a
separate HMAC-SHA-256 signed cookie verified in edge middleware on every request. This replicates
the pattern used in `GC_Knowledge_File_Handler`.

**Ingestion — client credentials.** Used only by the cron routes and cached per serverless
instance. Cron has no cookie jar, and an org-wide archive that depended on one person's session
would break the day their token was revoked.

Other measures:

- **CSRF**: origin validation against the request host, plus a double-submit token compared in
  constant time.
- **Cron authorisation**: routes are excluded from the session gate — they arrive with a bearer
  secret and no cookie, so a session check would reject every legitimate invocation — and instead
  validate `Authorization: Bearer $CRON_SECRET` in constant time. That secret is the only thing
  between the public internet and the org's entire Genesys API budget.
- **CSP**: strict, nonce-based, applied in middleware to every response. Roboto is self-hosted via
  `next/font`, so no external style or font origin is allowed.
- **Logging**: structured JSON with token-shaped strings, bearer headers and signed download URIs
  redacted before emission.

## Configuration

Copy `.env.example` to `.env.local` and fill it in. Every variable is documented there; this is the
summary.

| Variable                        | Required | Purpose                                                              |
| ------------------------------- | -------- | -------------------------------------------------------------------- |
| `APP_SESSION_SECRET`            | ✅       | Signs the app session, encrypts Genesys tokens in the cookie.        |
| `GENESYS_INGEST_CLIENT_ID`      | ✅       | Client-credentials identity for cron.                                |
| `GENESYS_INGEST_CLIENT_SECRET`  | ✅       | As above.                                                            |
| `GENESYS_REGION`                | ✅       | Region the ingestion talks to, e.g. `mypurecloud.de`.                |
| `CRON_SECRET`                   | ✅       | Authorises the cron routes.                                          |
| `POSTGRES_URL`                  | ✅       | Provided automatically by an attached Vercel Postgres store.         |
| `AVA_FLOW_IDS`                  |          | Pin ingestion to specific flows. Empty means every AVA-enabled flow. |
| `INGEST_LOOKBACK_MINUTES`       |          | Ingestion window. Default 30.                                        |
| `INGEST_MAX_EXECUTIONS_PER_RUN` |          | Ceiling per fidelity pass. Default 200.                              |
| `JOBS_MAX_IDS`                  |          | Measured Jobs ceiling. Default and maximum 10.                       |
| `SESSION_TTL_MINUTES`           |          | Session lifetime. Default 720.                                       |

### Genesys OAuth clients

You need **two**, because the two identities have different grant types.

**1. Interactive sign-in** — grant type _Code Authorization_. Its redirect URI must be your
deployment's callback exactly:

```
https://<your-app>.vercel.app/api/auth/callback
http://localhost:3000/api/auth/callback          # for local development
```

Users enter this client's id on the sign-in page; it is not configured as an environment variable.

**2. Ingestion** — grant type _Client Credentials_, with a role granting:

| Permission                            | Needed for                                    |
| ------------------------------------- | --------------------------------------------- |
| `architect:flow:view`                 | Listing flows and reading the AVA flag        |
| `architect:flowInstance:view`         | Submitting and reading execution-history jobs |
| `analytics:botFlowReportingTurn:view` | Reporting turns (the transcript)              |
| `analytics:botFlowSession:view`       | Bot flow sessions, if your org lists it       |

## Setup

### Local

```bash
cp .env.example .env.local     # then fill it in
npm install
npm run db:init                # applies src/server/db/schema.sql
npm run dev
```

Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Vercel

1. Import the repository, setting the root directory to `web`.
2. Attach a Postgres store — this provides `POSTGRES_URL` automatically.
3. Set the remaining environment variables from the table above.
4. Deploy, then run `npm run db:init` once against the production database (or apply
   `src/server/db/schema.sql` directly).
5. Add the deployment's `/api/auth/callback` URL to the interactive OAuth client.

> The ten-minute cron schedules in `vercel.json` require a plan that permits sub-daily crons. On a
> plan limited to daily crons the app still works, but ingestion runs once a day — and because
> reporting-turn retention is ten days, a daily cadence is enough to preserve transcripts, just not
> to keep dashboards current.

## Operating it

**What to watch.** The API budget view is the health check. Two signals matter:

- _Mean calls per execution climbing toward 2.0_ — batches are running nearly empty, because the
  fidelity pass finds only one or two pending conversations each time. Lengthening the cron
  interval raises batch fill and lowers the ratio. A job costs two calls whether it carries one id
  or ten.
- _Rate limiting above zero_ — 429s are honoured with the server's `Retry-After`, but sustained
  rate limiting means ingestion is competing with something else in the org.

**Troubleshooting.**

| Symptom                              | Likely cause                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No sessions at all                   | `AVA_FLOW_IDS` empty and the registry pass has not run, or no flow has the AVA flag set.                                                                              |
| Sessions but no traces, `NO_HISTORY` | Expected for abandoned conversations. If it is _every_ session on one flow, the flow likely has no exit path after the AVA response — fixable in Architect, not here. |
| Everything 403                       | The ingestion client is missing one of the three permissions above.                                                                                                   |
| Cron routes return 401               | `CRON_SECRET` mismatch between the environment and what Vercel sends.                                                                                                 |
| Transcript coverage below 100%       | Ingestion fell behind the ten-day retention window. Anything past it is unrecoverable.                                                                                |

## Limitations and known unknowns

- **Reporting-turn field names** are the least certain part of the integration. The turn-level
  metadata fields land on 31 Aug 2026; the raw entity is stored to absorb them, but the parsed
  columns may need revisiting once the shape is confirmed.
- **Tool latency is derived**, not reported. The execution history document carries no per-item
  duration, so latency is the interval to the next timeline item. It is a good proxy for a
  blocking call and a poor one for anything concurrent.
- **The sustainable API rate is unmeasured.** No `inin-ratelimit-*` headers were returned by the
  endpoints probed, so the app honours `Retry-After` reactively rather than pacing to a known
  ceiling.
- **Truncated traces** are flagged but not repaired. When the platform marks execution history
  incomplete, absence of an item is unknown rather than evidence that nothing happened.

## Project layout

```text
src/
  app/
    (app)/            dashboards: overview, tools, sessions, coverage, budget
    api/auth/         PKCE login, callback, logout
    api/cron/         registry, triage and fidelity ingestion passes
    api/health/       unauthenticated readiness probe
    login/            sign-in page
  components/         charts, trace timeline, shared UI primitives
  server/
    auth/             session signing, cookie policy, CSRF and cron guards
    genesys/          OAuth (both identities), HTTP transport with cost accounting,
                      AVA domain layer and trace parser
    db/               schema.sql and the query layer
    ingest/           the three ingestion passes
  middleware.ts       CSP and the session gate
test/                 unit tests over the pure security and parsing logic
scripts/init-db.mjs   applies the schema
```

## Checks

```bash
npm run check     # format, lint, typecheck, test
npm run build     # production build
```

The test suite covers the logic where a silent failure would be dangerous rather than merely
visible: session signing and verification (tampered payloads, tampered signatures, wrong secret,
expiry), the AES-256-GCM token cookie (opacity, fresh IV per seal, tamper rejection), region
normalisation, and the log redaction that keeps signed download URIs out of the logs.
