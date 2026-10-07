-- Migration 0139: `archivedLanes` projection on project_settings
-- (AQU-1626 follow-up; the read it serves is AQU-1458's).
--
-- The org dashboard flags a lane as archived when its `lanes` row says so, or
-- when an older project only recorded the tag in `settings.archivedLanes`. To
-- honour the second case, fetchPortfolioLanes
-- (auth-worker/src/services/org-permissions.ts) read
--
--   (ps.settings::jsonb)->'archivedLanes'
--
-- for every project on the page. `settings` is TEXT holding blobs that run to
-- several MB, so that one expression fetched and parsed every project's whole
-- blob to extract a short list that almost no project has: on dev, 7 of 5,944
-- rows mention the key at all. Measured there for an 8-org, 433-project
-- caller it was 4s warm and 10s cold, and the largest single statement left on
-- a request the SPA abandons at 15s. It is the same mistake migrations 0054
-- and 0063 exist to prevent, made after them.
--
-- Same fix as those: a STORED generated column pays the parse once, when the
-- settings are written, and cannot drift from the JSON. JSONB, like
-- `target_lanes` beside it, because the reader wants the array.
--
-- WHAT IT COSTS ON WRITE. Each generated column on this table casts the blob
-- for itself, so a settings write already parses it eight times; this makes
-- nine. One parse measured about 7 ms per MB on dev, so the largest blob there
-- (5.7 MB) pays about 40 ms more per save and the median row (116 bytes)
-- nothing measurable. A local Postgres 16 table with the same columns agreed
-- on the shape: saving a 5.5 MB blob took 170 ms with eight generated columns
-- and 190 ms with nine (7 ms with none). An UPDATE that leaves `settings`
-- alone does not recompute any of them.
--
-- WHAT IT COSTS TO APPLY. Adding a STORED column rewrites the table under an
-- ACCESS EXCLUSIVE lock: every blob is read, parsed once and written back, and
-- nothing else can read project_settings until it finishes. Nearly every
-- project request reads it. On dev, reading and parsing all 5,965 blobs
-- (550 MB of JSON) took 5.6s warm and 13.7s cold as a plain SELECT, and the
-- rewrite adds the write on top (locally, at dev's row and size mix, the
-- SELECT took 1.9s and this ALTER 2.2s). So expect the lock to be held for
-- 10 to 20 seconds on dev. Apply it at a quiet time, as with 0123, which did
-- the same rewrite.
--
-- Backward compatible: nothing reads the column until the worker that ships
-- with it deploys, and that worker must not deploy first. It selects
-- `ps.archived_lanes`, so on a database without this migration the dashboard's
-- lane query fails outright rather than degrading.

BEGIN;
-- Give up after 5s of WAITING for the lock (this does not limit how long the
-- rewrite then holds it). Without it, an ALTER stuck behind one long-running
-- reader makes every other reader queue behind the ALTER for as long as that
-- takes. If this times out nothing has changed: run the migration again.
SET LOCAL lock_timeout = '5s';

ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS archived_lanes JSONB
    GENERATED ALWAYS AS ((settings::jsonb)->'archivedLanes') STORED;
COMMIT;
