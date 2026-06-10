-- Migration 0036: add soft-delete tombstone column to `files` (FRO-272).
--
-- Semantics: when a user deletes a file via the file.delete event the
-- projection stamps `deleted_at` with the epoch timestamp (ms). The file row
-- is retained so cells / audio / event history remain queryable; cells are NOT
-- deleted.  A file.restore event clears `deleted_at` back to NULL.
--
-- R2 wipe is DEFERRED: no immediate purge.  A future cron or an explicit
-- "Delete forever" action calls the admin DELETE endpoint which continues to
-- do the actual R2 wipe (unchanged).  The retention period is 30 days by
-- convention (documented here; no cron is built in v1 — the "Delete forever"
-- button in the trash UI is the v1 purge mechanism).
--
-- NOT yet applied to the live database (as of 2026-06-10).
-- Apply via:  npx tsx scripts/neon-migrate.ts
-- (Or paste directly into the Neon SQL console for a single-shot manual run.)

ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at BIGINT DEFAULT NULL;

-- Index so the read route's `deleted_at IS NULL` filter is index-assisted.
CREATE INDEX IF NOT EXISTS idx_files_project_active
  ON files (project_id, deleted_at NULLS FIRST);
