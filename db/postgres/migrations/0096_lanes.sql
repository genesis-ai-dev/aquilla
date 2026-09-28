-- 0096_lanes.sql — AQU-1240 (v2): first-class lanes with opaque IDs.
--
-- Replaces the implicit '' default lane with real `lanes` rows. ADDITIVE and
-- BEHAVIOR-NEUTRAL: nothing reads this table until the per-project backfill
-- creates the rows, the `lane_id` columns land (next slice), and the laneOfEvent
-- shim is generalized to resolve to a lane_id. Creating the empty table changes
-- nothing and is reversible (DROP TABLE).
--
-- Columns, each load-bearing:
--   * id         — opaque 8-hex, app-generated (see src/lib/lanes/lane-id.ts).
--                  PRIMARY KEY is composite (project_id, id) so a project's
--                  child rows can only point at that project's lanes.
--                  Deliberately opaque so callers never parse it.
--   * role       — 'source' (one shared source lane per project, NOT lane-
--                  addressable) or 'target' (one per distinct target_lang value,
--                  including '' = the default lane).
--   * name       — human label. Auto-named from the language at creation, then
--                  editable. DELIBERATELY NOT UNIQUE — two "Spanish" lanes are
--                  allowed; the assignment/selection UI disambiguates (Win-2).
--   * lang_code  — BCP-47 tag, split from the display name. NULL is honest for a
--                  placeholder lane and is what language-aware features read.
--   * legacy_tag — IMMUTABLE. The target_lang value this lane had at cutover, so
--                  rename-safe replay resolves historical events by tag, never by
--                  name. '' for the default target lane; NULL for the source lane.
--   * position / archived_at — additive: stable display order and soft-archive.
--
-- No FK to projects (matches project_member_lane_roles; the app is event-sourced
-- and avoids FKs). Prod audit: mostly one target lane ('') per project, so most
-- projects get exactly two rows (one source + one default target).
CREATE TABLE IF NOT EXISTS lanes (
    id          TEXT        NOT NULL,   -- opaque 8-hex, app-generated (see src/lib/lanes/lane-id.ts)
    project_id  TEXT        NOT NULL,
    role        TEXT        NOT NULL CHECK (role IN ('source', 'target')),
    name        TEXT        NOT NULL,
    lang_code   TEXT,
    legacy_tag  TEXT,
    position    INTEGER     NOT NULL DEFAULT 0,   -- stable display order
    archived_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, id)
);

-- Exactly one source lane per project.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lanes_project_source
    ON lanes(project_id) WHERE role = 'source';

-- Deterministic tag -> lane resolution for target events (incl. '' default lane).
CREATE UNIQUE INDEX IF NOT EXISTS uq_lanes_project_legacy_tag
    ON lanes(project_id, legacy_tag) WHERE role = 'target';

CREATE INDEX IF NOT EXISTS idx_lanes_project
    ON lanes(project_id);
