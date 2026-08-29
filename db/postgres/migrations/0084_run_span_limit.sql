-- Migration 0084: per-run span limit — the "next step only" control
-- (docs/superpowers/specs/2026-08-28-agent-social-workspace-design.md §v3,
-- "Next step only": the start route accepts `spanLimit`, and the run parks
-- after N spans — the "translate the next passage, then I look" button).
--
-- NULL (the default, and every pre-existing row) means unlimited: the run
-- drafts the whole file exactly as it does today. A non-NULL value is a
-- ceiling on `done_spans + failed_spans`, checked at the same span edge that
-- already parks an exhausted cursor (lib/contextual/tick.ts runOneTick), so a
-- limited run settles through the ordinary parking path and its staged drafts
-- stay reviewable on a live run.
--
-- The limit must also be STICKY. `claimStrandedRuns` wakes any parked run with
-- spans left on its cursor — that is precisely a span-limited run, so without
-- the matching predicate there the 5-minute cron would resume the very run the
-- user asked to stop after one passage. The predicate is added in the same
-- change (db/shared/contextual-runs.ts); this column is what it reads.

ALTER TABLE contextual_runs ADD COLUMN IF NOT EXISTS span_limit integer;
