-- AVA observability archive.
--
-- Shaped around one fact from the platform: the three data sources have different coverage, so the
-- schema must be able to represent a conversation that session analytics can see but execution
-- history cannot. Sessions therefore remain separate from executions, joined by conversation id,
-- and an execution row can carry a "no history" terminal state rather than being absent.

CREATE TABLE IF NOT EXISTS ava_flows (
  flow_id           TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  flow_type         TEXT,
  division_id       TEXT,
  ava_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  published_version TEXT,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The AVA flag was observed changing within a single day during validation. Keeping the previous
  -- value makes drift visible instead of silently re-scoping ingestion.
  ava_enabled_changed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ava_flows_enabled_idx ON ava_flows (ava_enabled) WHERE ava_enabled;

-- The coverage spine: one call per flow returns every session with a classified outcome.
CREATE TABLE IF NOT EXISTS ava_sessions (
  session_id          TEXT PRIMARY KEY,
  flow_id             TEXT NOT NULL,
  conversation_id     TEXT,
  channel_name        TEXT,
  language            TEXT,
  end_language        TEXT,
  bot_result          TEXT,
  bot_result_category TEXT,
  date_created        TIMESTAMPTZ,
  date_completed      TIMESTAMPTZ,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ava_sessions_flow_created_idx ON ava_sessions (flow_id, date_created DESC);
CREATE INDEX IF NOT EXISTS ava_sessions_conversation_idx ON ava_sessions (conversation_id);
CREATE INDEX IF NOT EXISTS ava_sessions_category_idx ON ava_sessions (bot_result_category);

-- Full-fidelity execution history. `retrieval_status` carries the honest outcome, including the
-- case where the platform holds nothing and never will.
CREATE TABLE IF NOT EXISTS ava_executions (
  execution_id     TEXT PRIMARY KEY,
  flow_id          TEXT,
  flow_name        TEXT,
  flow_version     TEXT,
  conversation_id  TEXT,
  session_id       TEXT,
  start_date_time  TIMESTAMPTZ,
  end_date_time    TIMESTAMPTZ,
  duration_ms      INTEGER,
  truncated        BOOLEAN NOT NULL DEFAULT FALSE,
  error_count      INTEGER NOT NULL DEFAULT 0,
  warning_count    INTEGER NOT NULL DEFAULT 0,
  tool_call_count  INTEGER NOT NULL DEFAULT 0,
  item_count       INTEGER NOT NULL DEFAULT 0,
  retrieval_status TEXT NOT NULL,
  jobs_status_code TEXT,
  retrieval_attempts INTEGER NOT NULL DEFAULT 1,
  api_calls_per_execution NUMERIC(6, 3),
  bytes            INTEGER,
  trace            JSONB,
  retrieved_at     TIMESTAMPTZ,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ava_executions_conversation_idx ON ava_executions (conversation_id);
CREATE INDEX IF NOT EXISTS ava_executions_status_idx ON ava_executions (retrieval_status);
CREATE INDEX IF NOT EXISTS ava_executions_flow_start_idx ON ava_executions (flow_id, start_date_time DESC);

-- Tool calls flattened out of the trace so the dashboards do not have to open every JSONB blob.
CREATE TABLE IF NOT EXISTS ava_tool_calls (
  execution_id       TEXT NOT NULL,
  ordinal            INTEGER NOT NULL,
  flow_id            TEXT,
  conversation_id    TEXT,
  tool_name          TEXT NOT NULL,
  category           TEXT,
  succeeded          BOOLEAN NOT NULL,
  output_path_reason TEXT,
  output_path_reason_value TEXT,
  latency_ms         INTEGER,
  occurred_at        TIMESTAMPTZ,
  inputs             JSONB,
  outputs            JSONB,
  PRIMARY KEY (execution_id, ordinal)
);

CREATE INDEX IF NOT EXISTS ava_tool_calls_name_idx ON ava_tool_calls (tool_name, succeeded);
CREATE INDEX IF NOT EXISTS ava_tool_calls_occurred_idx ON ava_tool_calls (occurred_at DESC);

-- Ingestion accounting. This table is a first-class feature, not plumbing: the architecture's
-- claim is that observability costs ~0.2 API calls per execution, and a claim nobody measures in
-- production is a claim that quietly stops being true.
CREATE TABLE IF NOT EXISTS ingest_runs (
  id                SERIAL PRIMARY KEY,
  kind              TEXT NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL,
  finished_at       TIMESTAMPTZ NOT NULL,
  duration_ms       INTEGER NOT NULL,
  ok                BOOLEAN NOT NULL,
  api_calls         INTEGER NOT NULL DEFAULT 0,
  rate_limited      INTEGER NOT NULL DEFAULT 0,
  flows_scanned     INTEGER NOT NULL DEFAULT 0,
  sessions_seen     INTEGER NOT NULL DEFAULT 0,
  turns_seen        INTEGER NOT NULL DEFAULT 0,
  executions_discovered INTEGER NOT NULL DEFAULT 0,
  executions_retrieved  INTEGER NOT NULL DEFAULT 0,
  executions_no_history INTEGER NOT NULL DEFAULT 0,
  api_calls_per_execution NUMERIC(6, 3),
  error             TEXT,
  detail            JSONB
);

CREATE INDEX IF NOT EXISTS ingest_runs_kind_started_idx ON ingest_runs (kind, started_at DESC);
