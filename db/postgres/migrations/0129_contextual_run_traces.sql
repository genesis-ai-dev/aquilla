-- Migration 0129: contextual_run_traces — the prompt and reply of every
-- Autopilot model call, so the Team step inspector can show what the model was
-- asked and what it answered (auth-worker/src/lib/contextual/traces.ts).
--
-- Unlike contextual_run_events (bounded telemetry, never prompts or draft
-- text), this table holds the project's working text. It is read only by
-- project VIEWERs through /contextual/runs/:runId/traces and rows expire after
-- 30 days (pruned by the auth-worker 5-minute cron). Text fields are clipped
-- to 32k chars in code; `truncated` records that it happened.

CREATE TABLE IF NOT EXISTS contextual_run_traces (
  id                bigserial PRIMARY KEY,
  run_id            text NOT NULL,
  project_id        text NOT NULL,
  span_id           text NOT NULL DEFAULT '',
  label             text NOT NULL DEFAULT '',
  tier              text NOT NULL,
  model             text NOT NULL,
  system_prompt     text NOT NULL,
  user_prompt       text NOT NULL,
  output            text,
  error             text,
  generation_id     text,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cost_cents        double precision NOT NULL DEFAULT 0,
  latency_ms        integer NOT NULL DEFAULT 0,
  attempts          integer NOT NULL DEFAULT 1,
  truncated         boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contextual_run_traces_run_span
  ON contextual_run_traces(run_id, span_id, created_at, id);
-- Retention sweep.
CREATE INDEX IF NOT EXISTS contextual_run_traces_created
  ON contextual_run_traces(created_at);
