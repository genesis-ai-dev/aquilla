-- 0188: copy the retired `settings.archivedLanes` mirror onto `lanes.archived_at`
-- (AQU-2223).
--
-- Until this release the write path, the external API and the drafting gate
-- treated a target lane as archived when EITHER its row's `archived_at` was set
-- OR its tag / name was listed in `settings.archivedLanes` (case-insensitive;
-- never the `''` lane, which that list cannot name). The lane batch backfill
-- (AQU-1616) filled lane languages but never copied this list, so a lane
-- archived the old way — a settings PATCH, before the archive route set the
-- row — may still have `archived_at` NULL and be held archived only by the
-- mirror. AQU-2223 stops every reader of the mirror; without this copy those
-- lanes would quietly reopen and accept writes again (AQU-1462).
--
-- So: every target lane the old rule called archived gets `archived_at` now.
-- The original archive time is not recorded anywhere, so it is this
-- migration's time. A lane that is already archived keeps its timestamp. The
-- settings blob is not rewritten — history stays as it was.
--
-- Additive and backward-compatible: the code still live when this is applied
-- reads both the row and the mirror, and this only makes them agree.
-- `project_settings.wp_archived_lanes` is NOT dropped here — the live
-- sync-worker still selects it until this release deploys. Drop it one
-- release later, as 0156 did for the other generated language columns.
--
-- Dry run (read-only) — the rows this will archive:
--   SELECT l.project_id, l.id, l.legacy_tag, l.name
--     FROM lanes l
--     JOIN project_settings ps ON ps.project_id = l.project_id
--    WHERE l.role = 'target' AND l.archived_at IS NULL
--      AND COALESCE(l.legacy_tag, '') <> ''
--      AND jsonb_typeof(ps.settings::jsonb -> 'archivedLanes') = 'array'
--      AND EXISTS (
--        SELECT 1 FROM jsonb_array_elements(ps.settings::jsonb -> 'archivedLanes') AS e(v)
--         WHERE jsonb_typeof(e.v) = 'string' AND e.v #>> '{}' <> ''
--           AND (lower(e.v #>> '{}') = lower(l.legacy_tag)
--                OR lower(e.v #>> '{}') = lower(COALESCE(l.name, ''))));
--
-- Idempotent: a second run finds nothing left to archive.

UPDATE lanes AS l
   SET archived_at = now(), updated_at = now()
  FROM project_settings AS ps
 WHERE ps.project_id = l.project_id
   AND l.role = 'target'
   AND l.archived_at IS NULL
   AND COALESCE(l.legacy_tag, '') <> ''
   AND jsonb_typeof(ps.settings::jsonb -> 'archivedLanes') = 'array'
   AND EXISTS (
     SELECT 1
       FROM jsonb_array_elements(ps.settings::jsonb -> 'archivedLanes') AS e(v)
      WHERE jsonb_typeof(e.v) = 'string'
        AND e.v #>> '{}' <> ''
        AND (lower(e.v #>> '{}') = lower(l.legacy_tag)
             OR lower(e.v #>> '{}') = lower(COALESCE(l.name, '')))
   );
