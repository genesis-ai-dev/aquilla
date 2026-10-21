-- AQU-2057 (unified billing T2): workspace_usage_requests becomes the one
-- usage meter. Spec: docs/superpowers/specs/2026-10-19-unified-billing-meter-
-- and-entitlements.md §2.2. Only widens and adds columns with defaults, so
-- existing rows and the deployed workers keep working. Apply before deploying
-- the workers whose spend ceiling reads this table (db/shared/ai-spend-ceiling.ts).

-- Every paid call path maps to one rail.
ALTER TABLE workspace_usage_requests DROP CONSTRAINT IF EXISTS workspace_usage_requests_rail_check;
ALTER TABLE workspace_usage_requests ADD CONSTRAINT workspace_usage_requests_rail_check
  CHECK (rail IN ('llm', 'agent', 'jev', 'tts', 'audio', 'gpu', 'sandbox'));

-- metered: counts against the weekly allowance. unmetered: Enterprise, recorded
-- for cost only. byok: the customer's own key; raw_micro_cents is our estimate,
-- never platform spend.
ALTER TABLE workspace_usage_requests
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'metered';
ALTER TABLE workspace_usage_requests DROP CONSTRAINT IF EXISTS workspace_usage_requests_mode_check;
ALTER TABLE workspace_usage_requests ADD CONSTRAINT workspace_usage_requests_mode_check
  CHECK (mode IN ('metered', 'unmetered', 'byok'));

-- What the entitlement check decided. would_block is shadow mode (§5.4).
ALTER TABLE workspace_usage_requests
  ADD COLUMN IF NOT EXISTS decision TEXT NOT NULL DEFAULT 'allow';
ALTER TABLE workspace_usage_requests DROP CONSTRAINT IF EXISTS workspace_usage_requests_decision_check;
ALTER TABLE workspace_usage_requests ADD CONSTRAINT workspace_usage_requests_decision_check
  CHECK (decision IN ('allow', 'would_block', 'block'));

-- Background work (autopilot ticks, cron sweeps, brief summary at project
-- setup) has no live user and may have no project. NULL user_id is the system.
ALTER TABLE workspace_usage_requests ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE workspace_usage_requests ALTER COLUMN project_id DROP NOT NULL;

-- The platform spend ceiling sums today's rows across every org.
CREATE INDEX IF NOT EXISTS idx_workspace_usage_created
  ON workspace_usage_requests(created_at);
