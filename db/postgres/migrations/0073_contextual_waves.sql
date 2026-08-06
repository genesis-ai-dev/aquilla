-- 0073: contextual autopilot — wave execution + live streaming.
--
-- Three small additions, no data migration:
--
--   contextual_runs.anchor_cell_id  — where the user was looking when they hit
--     play. The first wave's seed list is rotated to start there, so the first
--     drafts land on screen instead of at the top of a file the user may be
--     nowhere near. Coverage is unchanged; only the ORDER of equal work moves.
--
--   contextual_runs.scope_group     — id shared by every run a single
--     project-wide start created, so the overview can report "18 of 27 files"
--     as one unit of work rather than 27 unrelated runs.
--
--   contextual_runs_driver          — index behind the stranded-run sweeper:
--     runs whose heartbeat (updated_at) has gone quiet while still 'running',
--     or that parked with spans left on the cursor. Before this, a run whose
--     driver died stayed 'running' forever with no way to resume it (resume
--     only accepts paused|parked), which every file over one loop's span cap
--     eventually hit.

ALTER TABLE contextual_runs ADD COLUMN IF NOT EXISTS anchor_cell_id text;
ALTER TABLE contextual_runs ADD COLUMN IF NOT EXISTS scope_group text;

CREATE INDEX IF NOT EXISTS contextual_runs_driver
  ON contextual_runs(status, updated_at)
  WHERE status IN ('running', 'parked');

CREATE INDEX IF NOT EXISTS contextual_runs_scope_group
  ON contextual_runs(scope_group)
  WHERE scope_group IS NOT NULL;
