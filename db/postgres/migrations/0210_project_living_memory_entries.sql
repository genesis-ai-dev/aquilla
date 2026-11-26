-- AQU-2719 step 1: the authored living-memory entries move off the
-- project_settings JSON blob and into rows of their own.
--
-- `project_settings.settings` is one JSON text column per project that the
-- schema comments call multi-MB, and the SPA's save is a whole-blob
-- read-modify-write. Every settings read parsed these entries whether or not
-- it wanted them, every save re-serialized them, and each of the 28 generated
-- columns parsed the same document once more (0150 measured one parse at
-- about 7 ms per MB on dev). This is the same move terminology made in 0084.
--
-- One row per entry, keyed on the entry's OWN client-minted id, so the
-- migration and the save path are both idempotent without a lock and a write
-- names the entries it read rather than replacing an array rebuilt from a
-- stale snapshot.
--
-- `sort_index` preserves the array order the blob expressed; it is the
-- position within the project, reassigned on every save, not an identity.
--
-- No foreign key to `project_settings`: a project's settings row is created
-- lazily by its first write (db/shared/projects.ts::loadProjectSettings
-- returns version 0 with no row), and entries are only ever written beside a
-- settings row in the same batch. Readers fall back to the blob whenever this
-- table has nothing to say, so an absent row is never an error.
CREATE TABLE IF NOT EXISTS project_living_memory_entries (
    entry_id   TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    -- 'instruction' | 'standard'. A legacy "instruction" entry only feeds
    -- translationInstructions on read (AQU-2342); the distinction is the
    -- reader's, so it is not constrained here.
    kind       TEXT NOT NULL DEFAULT 'standard',
    text       TEXT NOT NULL,
    author     TEXT NOT NULL DEFAULT '',
    -- The ISO string the entry carries, stored as given. Not a timestamp
    -- column: the blob's value is what every reader has always shown, and
    -- parsing it here would invent a date for an entry that never had one.
    created_at TEXT NOT NULL DEFAULT '',
    sort_index INTEGER NOT NULL DEFAULT 0
);

-- The only read pattern: every entry for one project, in order. The reader is
-- a correlated aggregate inside the settings SELECT
-- (db/shared/living-memory-entries.ts::LIVING_MEMORY_SELECT), so this index
-- is what keeps that aggregate off a sequential scan.
CREATE INDEX IF NOT EXISTS project_living_memory_entries_project_idx
    ON project_living_memory_entries (project_id, sort_index);
