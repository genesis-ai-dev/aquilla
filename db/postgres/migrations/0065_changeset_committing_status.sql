-- Migration 0065: W1-B commit idempotency — admit the transient 'committing'
-- changeset status (design 2026-07-17-agent-api-v1.1 §4).
--
-- Commit now sets status='committing' when it STARTS applying and 'committed'
-- at the end. A changeset found in 'committing' is a crash-retry: commit
-- re-enters it and re-posts the ids minted at prepare (event/file/cell), which
-- the /events idempotency layer (INSERT OR IGNORE on event id) dedupes — no
-- duplicate events, no duplicate file. The status CHECK constraint must admit
-- the new value.
--
-- The inline CHECK created in 0055 is auto-named `changesets_status_check` by
-- Postgres; drop and re-add it (idempotent via IF EXISTS) with the new value.
ALTER TABLE changesets DROP CONSTRAINT IF EXISTS changesets_status_check;
ALTER TABLE changesets
  ADD CONSTRAINT changesets_status_check
  CHECK (status IN ('staged', 'committing', 'committed', 'discarded', 'stale', 'expired'));
