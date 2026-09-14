-- Retention metrics: one row per user per UTC calendar day they used the app.
--
-- Why a rollup and not a query over `events`? The event log is ~23M rows / 28GB
-- with no global time index (only (project_id, server_ts)), and most of its
-- volume is the legacy-import mirror, not people. `org_members.last_active_at`
-- is the right "used the app" signal but keeps only the latest timestamp, so
-- it can't answer "was this user active in week 3 after signup". This table is
-- the durable per-day history that cohort retention and DAU/WAU/MAU need.
--
-- Written from auth-worker's bumpOrgActivity (already debounced to once per
-- 5 min per user), so a row costs one ON CONFLICT DO NOTHING per user per day.
-- Backfilled once from event history + login activity by
-- scripts/neon-backfill-activity.ts. Read only by the admin console
-- (GET /api/v2/admin/retention) and the emailed retention recap.

CREATE TABLE IF NOT EXISTS user_activity_days (
    user_id BIGINT NOT NULL,
    day     DATE   NOT NULL,
    PRIMARY KEY (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_user_activity_days_day ON user_activity_days(day);
