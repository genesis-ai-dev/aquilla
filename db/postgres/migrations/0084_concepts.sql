-- AQU-1006 follow-up: terminology concepts move from the project_settings
-- JSON blob onto the event log.
--
-- The blob stored the whole termbase under one key, so every add PATCHed the
-- entire array rebuilt from the writer's stale snapshot and concurrent adds
-- silently destroyed each other. This table is the projection of `term.*`
-- events: one row per concept, so a write names one concept and can no longer
-- overwrite entries it never read.
--
-- `renderings` is JSONB (an array of {rendering, status}) rather than its own
-- table: renderings have no stable identity of their own, are always read and
-- written as a set with their concept, and are never queried across concepts.

CREATE TABLE IF NOT EXISTS concepts (
    concept_id     TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL,
    source_term    TEXT NOT NULL,
    renderings     JSONB NOT NULL DEFAULT '[]'::jsonb,
    notes          TEXT,
    -- 'active' | 'draft' | 'deprecated'. Only 'active' compiles to rules.
    status         TEXT NOT NULL DEFAULT 'draft',
    case_sensitive INTEGER NOT NULL DEFAULT 0,
    created_by     TEXT,
    created_at     BIGINT NOT NULL,
    updated_at     BIGINT NOT NULL,
    deleted_at     BIGINT
);

-- The only read pattern: every live concept for a project, for rule
-- compilation. Partial on deleted_at so tombstones don't widen it.
CREATE INDEX IF NOT EXISTS concepts_project_live_idx
    ON concepts (project_id)
    WHERE deleted_at IS NULL;
