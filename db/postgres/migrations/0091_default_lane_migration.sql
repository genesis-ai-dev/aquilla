-- 0091_default_lane_migration.sql — AQU-1240: eliminate the implicit '' default lane.
--
-- Per-project record of the default-lane migration. This is NOT temporary
-- scaffolding: it is the permanent lookup the replay shim (laneOfEvent, slice 3)
-- needs to resolve legacy '' / absent target lanes to a project's real lane tag,
-- for as long as any legacy event exists (i.e. forever).
--
--   * project_id    — the project whose default lane was resolved.
--   * resolved_lane — the real lane tag the default lane ('') was named. The
--                     shim maps absent/'' targetLang on target.cell.* events to
--                     this value. NEVER '' (an empty tag would defeat the point).
--   * ran_at        — when the backfill (slice 5) ran for this project.
--   * rows_by_table — JSON audit of rows relabeled per table, for reversibility
--                     and reconciliation.
--
-- A project with NO row here is one created AFTER cutover, whose events all carry
-- explicit tags. For such a project the shim MUST THROW (not default) if it ever
-- meets a legacy-shaped event — "I cannot determine the lane" is only safely
-- answered by refusing. See
-- docs/superpowers/specs/2026-09-09-eliminate-default-lane-design.md §2.3, §2.5.
--
-- STRUCTURE ONLY: nothing reads or writes this table until slice 3 (shim) and
-- slice 5 (backfill). Creating it now is safe, empty, and reversible.
CREATE TABLE IF NOT EXISTS default_lane_migration (
    project_id    TEXT NOT NULL PRIMARY KEY,
    resolved_lane TEXT NOT NULL CHECK (resolved_lane <> ''),
    ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    rows_by_table JSONB
);
