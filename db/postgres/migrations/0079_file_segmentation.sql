-- Migration 0079: per-file segmentation strategy (autopilot span seeds).
--
-- Segmentation is a property of the SOURCE, so this table is keyed by
-- (project, file) with NO target_lang: every language lane of a file reads the
-- same boundaries. Before this table the segmentation was derived per RUN and
-- stored in contextual_runs.span_cursor, which meant two lanes recomputed it
-- independently, it was discarded when the run ended, and nothing outside the
-- run could see or correct it.
--
-- Three strategies:
--   auto     — derive from file structure (canonical refs → paragraph marks →
--              fixed chunks). The default; a file with no row here is 'auto'.
--   fixed    — cut every `fixed_size` cells. The blunt human override for a
--              file whose derived boundaries a translator judged wrong.
--   explicit — `boundaries` holds the ordered span list verbatim. This is the
--              shape an LLM re-segmentation pass writes: contiguous,
--              non-overlapping, covering the file, each entry optionally
--              carrying a title/gist/depth so the same rows can drive a
--              navigation outline.
--
-- `human_edited` pins a row a person set so an automated re-segmentation can
-- never silently overwrite it. `stale_since`/`stale_reason` mirror
-- scene_briefs: a source edit can move boundaries out from under a stored
-- segmentation, and the marker is instant while re-work is debounced elsewhere.

CREATE TABLE IF NOT EXISTS file_segmentation (
  project_id   text NOT NULL,
  file_id      text NOT NULL,
  strategy     text NOT NULL DEFAULT 'auto'
    CHECK (strategy IN ('auto', 'fixed', 'explicit')),
  fixed_size   integer,          -- strategy='fixed'; clamped by the caller
  boundaries   jsonb,            -- strategy='explicit'; ordered [{startCellId,endCellId,title?,gist?,depth?}]
  note         text,             -- the human's extra instruction for a re-segmentation
  generated_by text,             -- 'human' | 'model'
  model_id     text,             -- when generated_by='model'
  human_edited boolean NOT NULL DEFAULT false,
  stale_since  timestamptz,      -- instant marker; NULL = fresh
  stale_reason text,             -- 'source-edit' | 'endpoint-tombstoned' | ...
  version      integer NOT NULL DEFAULT 1,
  updated_by   text,             -- username
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, file_id),
  -- The strategy and its payload must agree: a 'fixed' row without a size, or
  -- an 'explicit' row without boundaries, would silently fall back to 'auto'
  -- at read time and the UI would show a setting that does nothing.
  CHECK (strategy <> 'fixed' OR fixed_size IS NOT NULL),
  CHECK (strategy <> 'explicit' OR boundaries IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS file_segmentation_project
  ON file_segmentation(project_id);
