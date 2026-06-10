-- Migration 0037: track AI-drafted cells (FRO-292, audit F-C3 §3.9).
--
-- Adds `ai_drafted` to `cells` and `ai_drafted_count` to `files` so that
-- the ProjectOverview can surface a third progress segment:
--   "Translated" = human-edited or AI-accepted-then-edited cells
--   "Drafted by AI, awaiting review" = AI-origin cells not yet human-edited
--   "Validated" = cells that have passed reviewer endorsement
--
-- Reclassification rules enforced by the projection:
--   ai_drafted → 1 when target.cell.commit carries payload.ai_suggestion = true
--   ai_drafted → 0 when a subsequent human target.cell.commit lands (no ai_suggestion)
--   ai_drafted → 0 when cell.validate fires (validation supersedes; the cell
--                   is now "Validated", not "AI-drafted awaiting review")
--
-- Forward-only: historical commits in the events log are indistinguishable
-- (they carry no ai_suggestion field). All pre-migration cells start at
-- ai_drafted = 0 (the default), which is honest — we cannot infer provenance
-- from commits that pre-date this marker.
--
-- NOT yet applied to the live Neon instance (as of 2026-06-10, FRO-292 deploy).
-- See SWARM-TODO in the Linear comment: apply at deploy time.

BEGIN;

-- Step 1: add ai_drafted column to cells (0 = human or unknown, 1 = AI-origin
-- and not yet human-edited/validated).
ALTER TABLE cells ADD COLUMN IF NOT EXISTS ai_drafted INTEGER NOT NULL DEFAULT 0;

-- Step 2: add ai_drafted_count rollup column to files (recomputed by the
-- projection the same way approved_count and filled_count are recomputed).
ALTER TABLE files ADD COLUMN IF NOT EXISTS ai_drafted_count INTEGER NOT NULL DEFAULT 0;

-- Step 3: initialise files.ai_drafted_count from the (all-zero) cells table.
-- This is a no-op for a fresh deploy but makes the migration idempotent on a
-- DB where the column already existed with data.
UPDATE files
SET ai_drafted_count = (
  SELECT COUNT(*)
  FROM cells c
  WHERE c.project_id = files.project_id
    AND c.file_id    = files.id
    AND c.side       = 'target'
    AND c.ai_drafted = 1
);

COMMIT;
