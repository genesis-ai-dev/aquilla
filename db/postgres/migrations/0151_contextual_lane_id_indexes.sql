-- 0151_contextual_lane_id_indexes.sql — AQU-1610
--
-- The contextual pipeline's three uniqueness rules and its newest-run-per-lane
-- index still spelled "lane" as `target_lang`, the legacy tag. Row identity is
-- `lane_id` (AQU-1420, migration 0114), and `lane_id` has been NOT NULL on all
-- three tables since AQU-1240, so the tag buys nothing here and costs
-- correctness: two lanes whose tags agree (a lane retagged after its rows were
-- written, or a lane tagged with its own id) share one uniqueness slot, so the
-- second lane's active run, live draft, or approved brief collides with the
-- first lane's.
--
-- `target_lang` itself stays — AQU-1611 drops the projection columns. This
-- migration only moves the keys off it.
--
-- Aborts if two live rows already share the new key: that is a content
-- collision to look at, not something to swallow. It cannot happen from the
-- tag-keyed rules alone (one tag maps to at most one lane per project —
-- `uq_lanes_project_legacy_tag`), so an abort here means rows written before
-- `lane_id` was populated.
--
-- Idempotent: an index already keyed on lane_id is left alone. Not
-- CONCURRENTLY — these are small tables and the unique indexes must not be
-- missing even briefly, so the whole file runs as one transaction.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'scene_briefs_live'
       AND indexdef LIKE '%target_lang%'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.scene_briefs WHERE status = 'approved'
      GROUP BY project_id, file_id, start_cell_id, end_cell_id, lane_id
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'AQU-1610: approved scene_briefs are not unique per (project, file, span, lane_id)';
    END IF;
    DROP INDEX public.scene_briefs_live;
    CREATE UNIQUE INDEX scene_briefs_live
      ON public.scene_briefs(project_id, file_id, start_cell_id, end_cell_id, lane_id)
      WHERE status = 'approved';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'contextual_runs_active'
       AND indexdef LIKE '%target_lang%'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.contextual_runs
       WHERE status IN ('running','pausing','paused','parked','waiting')
      GROUP BY project_id, file_id, lane_id
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'AQU-1610: active contextual_runs are not unique per (project, file, lane_id)';
    END IF;
    DROP INDEX public.contextual_runs_active;
    CREATE UNIQUE INDEX contextual_runs_active
      ON public.contextual_runs(project_id, file_id, lane_id)
      WHERE status IN ('running','pausing','paused','parked','waiting');
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'contextual_drafts_live'
       AND indexdef LIKE '%target_lang%'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.contextual_drafts WHERE status = 'proposed'
      GROUP BY project_id, file_id, cell_id, lane_id
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'AQU-1610: proposed contextual_drafts are not unique per (project, file, cell, lane_id)';
    END IF;
    DROP INDEX public.contextual_drafts_live;
    CREATE UNIQUE INDEX contextual_drafts_live
      ON public.contextual_drafts(project_id, file_id, cell_id, lane_id)
      WHERE status = 'proposed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'contextual_runs_project_lane_time'
       AND indexdef LIKE '%target_lang%'
  ) THEN
    DROP INDEX public.contextual_runs_project_lane_time;
    CREATE INDEX contextual_runs_project_lane_time
      ON public.contextual_runs(project_id, file_id, lane_id, created_at DESC, id DESC);
  END IF;
END $$;
