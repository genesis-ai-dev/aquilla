-- 0158_rate_limit_counters.sql — AQU-1843
--
-- Backs the rewritten shared volumetric limiter (db/shared/rate-limit.ts),
-- which the chat proxy, the AI/Jev routes, audio transcription, TTS and the
-- external Agent API all call.
--
-- The old limiter did `SELECT COUNT(*)` over a trailing 15-minute window of
-- `auth_rate_limit_events` and then INSERTed one more row. Two statements, so
-- a parallel burst all read the same pre-burst count and every request passed;
-- one row written per request into a table nothing on the sync-worker side
-- pruned; and a lookup error returned 0, which disabled every throttle at once.
--
-- This table holds ONE row per (kind, identifier, window). The check becomes a
-- single `INSERT ... ON CONFLICT DO UPDATE SET hits = hits + EXCLUDED.hits
-- RETURNING hits` upsert: `ON CONFLICT DO UPDATE` takes a row lock, so
-- concurrent callers serialize on that row and each is handed a distinct
-- ordinal, which is what makes the decision atomic. `window_start` is the
-- epoch-aligned start of a fixed window, computed by Postgres so both workers
-- bucket on one clock.
--
-- Finished windows are deleted by the auth-worker 5-minute cron
-- (pruneRateLimitCounters, auth-worker/src/index.ts `scheduled`) — the same
-- move `pruneExpiredRevokedTokens` made away from an opportunistic
-- request-path DELETE.
--
-- No app_runtime grant and no RLS, matching the `auth_rate_limit_events` table
-- it supersedes: a non-project-scoped infrastructure table with no tenant
-- column for a policy to key on (see db/postgres/RLS.md).
--
-- `auth_rate_limit_events` is NOT dropped here: auth-worker's own login /
-- password-reset / admin-elevation throttles still use it (they count failures
-- only and need the per-attempt rows to do that). What changes for that table
-- is that its rows are now pruned on the same cron instead of by a random
-- 2%-of-calls DELETE.
--
-- DEPLOY ORDER: apply this BEFORE the code that reads it reaches an
-- environment. Until it is applied, every throttle in that environment is OFF:
-- enforceRateLimit treats SQLSTATE 42P01 as "limiter not installed" and allows
-- the call through (logging an error) even on the fail-closed paid routes,
-- deliberately — refusing them would take chat, agent runs, transcription and
-- TTS down entirely rather than protect anything. So a late migration costs
-- uncapped spend for that window, which is the pre-AQU-1843 status quo, not an
-- outage. The PR bot walk caught exactly this on a preview whose development
-- storage did not have the table.
--
-- Apply by hand against Neon (same convention as prior migrations here):
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0158_rate_limit_counters.sql
-- Verify: `rate_limit_counters` exists with the composite primary key and the
-- `idx_rate_limit_counters_window` index.
--
-- Idempotent. A database loaded from schema.sql already has the table.

CREATE TABLE IF NOT EXISTS rate_limit_counters (
    kind         TEXT NOT NULL,
    identifier   TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    hits         INTEGER NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, identifier, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window
  ON rate_limit_counters(window_start);
