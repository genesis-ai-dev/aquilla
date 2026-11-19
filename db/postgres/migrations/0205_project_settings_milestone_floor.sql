-- Migration 0205: project the milestone floor out of project_settings.settings
-- (AQU-2309).
--
-- WHY. Who may set, rename, resize and remove milestones is a project
-- setting. The default, and every project that has never touched the key,
-- is maintainer. A project may open it to project lead. POST /events has to
-- answer it on every file.milestone.set and file.milestone.remove, and the
-- write path reads project settings through the wp_ projection 0171 added
-- (sync-worker/src/events/write-path-settings.ts) so no events-route
-- statement opens the multi-MB settings TEXT column. This key joins that
-- projection rather than becoming the one read that reopens the blob.
--
-- JSONB and not `->>` TEXT, for 0171's reason: the reader's guard is
-- `=== 'project_lead'`, and `->>` would stringify a JSON number into text
-- the guard could not tell from a real rung. `->` keeps the value's JSON
-- type, so an unrecognised value stays unrecognised and reads as maintainer
-- (db/shared/milestone-floor.ts) — never looser than the default.
--
-- WHAT IT COSTS TO APPLY. Adding a STORED generated column rewrites the
-- table under an ACCESS EXCLUSIVE lock: every blob is read and parsed, and
-- nothing can read project_settings until the rewrite ends. One column, one
-- statement, one rewrite. Apply it at a quiet time, as with 0171.
--
-- DEPLOY ORDER. Apply this before the sync-worker that reads the column —
-- but it is not a safety requirement: on a database without it the reader
-- falls back to the blob read and narrows it in the Worker
-- (request-cache.ts), so the authority answer is identical either way.
--
-- Switching the stored tier does not touch file_milestones or any cell.
-- The column is a projection of one settings key.

BEGIN;
-- Give up after 5s of WAITING for the lock (this does not limit how long the
-- rewrite then holds it), so the ALTER cannot queue every reader behind one
-- long-running transaction. If this times out nothing has changed: run the
-- migration again.
SET LOCAL lock_timeout = '5s';

ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS wp_milestone_floor JSONB
    GENERATED ALWAYS AS ((settings::jsonb) -> 'milestoneFloor') STORED;
COMMIT;
