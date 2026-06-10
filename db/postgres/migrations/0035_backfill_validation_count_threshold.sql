-- Migration 0034: backfill cells.validated and files.approved_count for
-- projects whose validationCount > 1 (FRO-279, audit F-B1 fix).
--
-- BEFORE FRO-279: cells.validated = 1 when COUNT(cell_validators) > 0.
-- AFTER  FRO-279: cells.validated = 1 when COUNT(cell_validators) >= validationCount.
--
-- For projects with validationCount = 1 (or unset) the new formula is
-- byte-identical to the old one — no rows change.  Only projects that
-- explicitly set validationCount >= 2 in project_settings need correction.
--
-- WARNING: run this ONLY after the FRO-279 projection change ships to the
-- worker.  Running it before the projection change would have no lasting
-- effect (the next cell.validate event would re-project with the old logic).
--
-- NOT yet run against live data (as of 2026-06-10 FRO-279 deploy).
-- This is the deploy-time step documented in the FRO-279 Linear comment.
--
-- Approach: set-based SQL, no per-row loops, single transaction.
-- Step 1: recompute cells.validated for every target cell in projects with
--         configured validationCount > 1.
-- Step 2: recompute files.approved_count for every file in those projects.

BEGIN;

-- Step 1: recompute cells.validated using the correct threshold.
--
-- CTE resolves each project's validationCount from project_settings.
-- We cast the JSON value to integer; projects without the key get NULL
-- (treated as threshold=1, which means no change to their cells).
--
-- Only project_id rows where threshold > 1 are processed — the predicate
-- `threshold > 1` ensures N=1 projects are untouched (set-based no-op).
WITH project_thresholds AS (
  SELECT
    project_id,
    GREATEST(1, COALESCE(
      ((settings::jsonb) ->> 'validationCount')::int,
      1
    )) AS threshold
  FROM project_settings
  WHERE ((settings::jsonb) ->> 'validationCount')::int > 1
),
correct_validated AS (
  SELECT
    c.project_id,
    c.file_id,
    c.cell_id,
    c.side,
    CASE
      WHEN (
        SELECT COUNT(*)
        FROM cell_validators cv
        WHERE cv.project_id = c.project_id
          AND cv.file_id    = c.file_id
          AND cv.cell_id    = c.cell_id
          AND cv.event_id   = c.event_id
      ) >= pt.threshold THEN 1
      ELSE 0
    END AS new_validated
  FROM cells c
  JOIN project_thresholds pt ON pt.project_id = c.project_id
  WHERE c.side = 'target'
)
UPDATE cells
SET validated = correct_validated.new_validated
FROM correct_validated
WHERE cells.project_id = correct_validated.project_id
  AND cells.file_id    = correct_validated.file_id
  AND cells.cell_id    = correct_validated.cell_id
  AND cells.side       = correct_validated.side
  AND cells.validated != correct_validated.new_validated;

-- Step 2: recompute files.approved_count for every file in affected projects.
--
-- Uses the now-corrected cells.validated values (Step 1 committed above
-- in the same transaction).
WITH project_thresholds AS (
  SELECT project_id
  FROM project_settings
  WHERE ((settings::jsonb) ->> 'validationCount')::int > 1
)
UPDATE files
SET approved_count = (
  SELECT COUNT(*)
  FROM cells c
  WHERE c.project_id = files.project_id
    AND c.file_id    = files.id
    AND c.validated  = 1
)
FROM project_thresholds pt
WHERE files.project_id = pt.project_id;

COMMIT;
