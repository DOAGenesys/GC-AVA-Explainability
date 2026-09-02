# AVA Observability

An event-driven explainability workspace for Genesys Cloud Agentic Virtual Agents.

The application watches completed flow executions in real time, extracts the exact execution
pointer from each notification, retrieves full execution history through the bulk Jobs API, and
archives tool-level evidence in Postgres.

## The capture contract

The application subscribes to one topic only:

```text
v2.flows.instances.flow.{id}
```

Its event body carries the three identifiers the archive needs:

```json
{
  "executionId": "5c1550fd-dbb7-5da1-b337-25b42af123d7",
  "flowId": "56155fa0-92cd-574b-b7cf-0fafad91fd2f",
  "conversationId": "33b6e980-095b-51a7-ae3e-02be439ac4bc"
}
```

That eliminates `/api/v2/flows/instances/query` entirely. There is no conversation-to-execution
discovery step and no scheduled polling.

## How capture works

1. The user signs in with Genesys Cloud using Authorization Code + PKCE.
2. In **Live capture**, the user adds one or many concrete flow IDs.
3. The server creates one authenticated Notifications channel.
4. The browser subscribes to one `v2.flows.instances.flow.{id}` topic per selected flow.
5. Each event is validated and deduplicated by `executionId`.
6. Pointers collect until either:
   - ten executions are ready,
   - the 30-second flush timer expires,
   - the user chooses **Archive pending now**, or
   - capture is stopped.
7. The server submits up to ten execution IDs to `/api/v2/flows/instances/jobs`.
8. Successful download payloads are parsed and stored in `ava_executions`; tool calls are flattened
   into `ava_tool_calls`.

The browser shows each event moving through `Queued → Retrieving trace → Archived`, with distinct
states for permanent `NO_HISTORY`, retryable download failures, duplicates, and already-settled
executions.

## API efficiency

Live channel creation costs one Platform API call. WebSocket events themselves consume no polling
budget.

Execution history uses the measured Jobs ceiling:

| Batch fill | Platform calls | Calls per execution |
| ---------- | -------------- | ------------------- |
| 1          | 2              | 2.0                 |
| 5          | 2              | 0.4                 |
| 10         | 2              | **0.2**             |

Ten execution IDs are accepted; eleven receive a hard `422`. The application caps requests at ten
and retains the existing bisect behavior for a rejected batch. History downloads are served from
the regional download host and do not consume the Platform API allowance.

Before submitting a job, the server skips execution IDs already stored as `ARCHIVED` or
`NO_HISTORY`, so duplicate notifications and repeated captures do not spend Genesys API budget.

## Bot Flows - Reporting Turns

The **Reporting turns** section queries:

```text
GET /api/v2/analytics/botflows/{botFlowId}/divisions/reportingturns
```

This is a separate, on-demand explainability source. One API page returns up to 250 turns across
many sessions for a bot flow, filtered by the signed-in user's permitted divisions and ordered with
the newest session first. The view exposes user input, bot prompts, ask-action outcomes, intents,
slots, knowledge searches and feedback, guardrail outcomes, and session-end details.

The server retrieves at most four Genesys pages per browser response (up to 1,000 turns), then
offers **Load next 1,000 turns** when more data exists. Continuation requests forward the
already-encoded `nextUri` supplied by Genesys without encoding it again. The result is complete only
when `nextUri` is absent.

Reporting Turns is not a replacement for Jobs: it explains the conversational and analytics
evidence in bulk, while Jobs supplies the complete execution timeline and tool input/output
evidence. Reporting Turns is also not added to the permanent archive by this interactive view.
Genesys deletes these resources after approximately, but not before, 10 days.

## User experience

The Live capture studio provides:

- multi-flow paste, known-flow suggestions, and removable flow chips;
- explicit channel, topic, heartbeat, pending-batch, Jobs and efficiency indicators;
- automatic and manual batch flush;
- retry controls for transient Jobs/download failures;
- an in-product notification with a direct link whenever a captured session becomes ready;
- copy-by-field, copy-selected-fragment, copy-event and copy-all actions;
- a navigation guard when unarchived pointers remain in the browser;
- an in-memory event limit of 500 entries.

The dashboard, API budget and capture coverage pages read the resulting archive. The Sessions view
combines historical analytics rows with event-driven sessions projected from completed Jobs
results. A Jobs-derived session includes the flow exit, nested AVA conversation and tool evidence;
channel and bot-session analytics classifications remain unknown because they are not part of
execution history.

## Important coverage boundary

This is an interactive WebSocket capture surface. A topic is active only while a signed-in browser
keeps the page open, and WebSocket topics require concrete flow IDs—wildcards are not supported.
The coverage page therefore reports outcomes for **observed executions**, not an estimate of every
execution in the org.

Genesys only emits retrievable execution history for executions that terminate and are retained.
An explicit Jobs `404` is stored as `NO_HISTORY` and never retried. Other failures remain retryable.

For an always-on production collector, use the same event-pointer and ten-ID Jobs batching contract
behind a durable transport such as EventBridge. The browser implementation intentionally optimizes
interactive investigation rather than claiming background durability.

## Security

- Genesys access and refresh tokens remain in an AES-256-GCM encrypted HttpOnly cookie.
- The browser receives only the opaque Genesys WebSocket `connectUri`.
- Channel creation and Jobs capture routes require a signed app session and same-origin CSRF token.
- All Genesys operations run as the signed-in user; there is no stored client-credentials identity.
- The CSP permits only the regional Genesys streaming host families in addition to same-origin
  connections.
- Event payloads are not logged. Channel URIs and OAuth tokens are never persisted.

The signed-in user needs permission to create notification subscriptions and view Architect flow
instances for the selected divisions.

## Configuration

Copy `.env.example` to `.env.local`:

| Variable                        | Required | Purpose                                      |
| ------------------------------- | -------- | -------------------------------------------- |
| `APP_SESSION_SECRET`            | Yes      | Session signing and token-cookie encryption. |
| `POSTGRES_URL`                  | Yes      | Execution and capture archive.               |
| `GENESYS_REGION`                | No       | Default region shown at sign-in.             |
| `JOBS_MAX_IDS`                  | No       | Jobs ceiling; default and maximum is 10.     |
| `SESSION_TTL_MINUTES`           | No       | Signed-in session lifetime; default 720.     |
| `NEXT_PUBLIC_ENVIRONMENT_LABEL` | No       | Sidebar environment label.                   |
| `NEXT_PUBLIC_APP_VERSION`       | No       | Sidebar version label.                       |

Apply the database schema once:

```powershell
npm install
npm run db:init
```

Run locally:

```powershell
npm run dev
```

Before deployment:

```powershell
npm run check
npm run build
```

## Key files

```text
src/app/(app)/live/page.tsx             Capture page
src/components/notification-stream.tsx  Multi-flow WebSocket, queue and capture UX
src/lib/notification-events.ts          Topic construction and event-pointer validation
src/app/api/notifications/channel/      Authenticated channel creation
src/app/api/capture/executions/         Authenticated Jobs batch endpoint
src/server/capture/                      Deduplication, retrieval and persistence
src/server/genesys/ava.ts               Jobs API and execution trace parser
src/app/(app)/reporting-turns/          Division-aware Reporting Turns view
src/app/api/reporting-turns/             Paginated Reporting Turns proxy
src/server/genesys/reporting-turns.ts   Opaque nextUri traversal
src/server/db/index.ts                   Archive writes, capture metrics and reads
src/server/db/schema.sql                 Postgres schema
```

## Verification

`npm run check` runs formatting, strict lint, TypeScript and the Vitest suite. The tests include the
real flow-instance notification contract, multi-flow topic building, pointer validation, ten-ID
capture limits, deduplication and trace parsing.
