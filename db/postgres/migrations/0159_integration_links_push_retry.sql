-- 0159_integration_links_push_retry.sql — AQU-1828
--
-- Retry state for the Monday progress push. Until now every push outcome —
-- success OR failure — cleared `dirty_at` (lib/monday/push.ts
-- recordPushOutcome), so a link whose push failed on a 429 or a Monday 5xx was
-- dropped from the cron flush set and never retried: the board silently stopped
-- tracking the project until the next edit happened to land outside the
-- debounce window.
--
-- `push_attempts` counts consecutive failed attempts (reset to 0 on success) and
-- `next_retry_at` is when the flush may try again, so the cron can back off
-- instead of hammering a failing board and burning its per-run cap of 20 links
-- on the same bad link every minute.
--
-- Both columns are retry bookkeeping only: a NULL `next_retry_at` means "try
-- whenever dirty", which is exactly how every pre-existing row behaves.
--
-- Idempotent. A database loaded from schema.sql already has the columns.

ALTER TABLE integration_links
  ADD COLUMN IF NOT EXISTS push_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE integration_links
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
