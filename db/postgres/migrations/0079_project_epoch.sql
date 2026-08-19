-- Migration 0079: project incarnation epoch on the seq counter (AQU-943).
--
-- Deleting every row for a project (project + events + cells + its
-- project_seq_counters row) and re-migrating it recreates the project under
-- the SAME deterministic project/file ids — but the per-project seq allocator
-- restarts near 1. A browser that viewed the OLD incarnation still holds
-- per-file `?since=` cursors and ETags from the old (higher) seq range, so
-- every delta read answers "nothing newer than your cursor" and the client
-- renders its pre-wipe cache forever. Neither the cells-read ETag
-- (`fileId:rebuiltSeq:maxSeq`) nor the `since < rebuilt_seq` resync gate can
-- see the wipe, because neither embeds any notion of the project's
-- incarnation.
--
-- project_epoch is that notion: a fresh microsecond stamp minted whenever the
-- counter row is CREATED. The counter row is exactly the row whose deletion
-- restarts the allocator, so epoch and seq range are born and destroyed
-- together — a re-created project always carries a different epoch than the
-- one a stale client's cursor was minted against. cells-read-route.ts folds it
-- into the ETag and answers `{resync:true}` when a client's declared epoch
-- doesn't match, forcing the full refetch that converges the client.
--
-- clock_timestamp() (not now()) so a wipe + re-create inside ONE transaction
-- still produces a distinct epoch. Existing rows all take the migration's
-- stamp, which is all that is required: it only has to differ from the epoch
-- of any row created later.
--
-- Idempotent — safe to re-apply.

ALTER TABLE project_seq_counters
  ADD COLUMN IF NOT EXISTS project_epoch BIGINT NOT NULL
    DEFAULT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::BIGINT;
