-- Migration: 0012_files_meta_event_id.sql
-- Description: Bring `files` and `cell_validators` in line with the spec's
--   data model (03-data-model.md, 2026-05-21 revision).
--
--   Both tables are read projections regenerable from the event log, so we
--   drop+recreate rather than ALTER (mirrors how 0006 rebuilt `cells`).
--   No backfill — no users yet (project_no_users_yet memory); the sync
--   worker re-projects from `events` on next write / rebuild.
--
-- ── files ─────────────────────────────────────────────────────────────
--   * Adds `event_id` (AD-2 chain head — the most recent winning
--     file.create / file.update event on this file_id; mirrors cells.event_id).
--   * Adds a JSON `meta` column following the §"Column vs JSON meta"
--     convention: sparse / schema-evolving provenance + per-file overrides
--     (r2_key, blob_sha, import_format, parser_version, source_language,
--     target_language) live here instead of as dedicated columns.
--   * Keeps the semantic columns that get queried / joined / sorted:
--     role, kind, book_code, source_file_id, anchor_file_id.
--   * Drops the legacy `file_type` column (collapsed into role + kind) and
--     `projected_from`. The files-read route derives a backward-compatible
--     `fileType` response field as `kind ?? role ?? 'codex'`.
--
-- ── cell_validators ───────────────────────────────────────────────────
--   * Drops `is_active` in favor of DELETE-on-unvalidate (cell.validate →
--     INSERT/UPSERT; cell.unvalidate → DELETE the row).
--   * Renames `edit_event_id` → `event_id` (the cell.validate event's target
--     commit; still drives event-anchored validation via event_id ==
--     cells.event_id).
--   * PK is now (project_id, file_id, cell_id, username) — one row per
--     (cell, validator), per the spec's indicative schema.

-- ── files ─────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS files;

CREATE TABLE files (
    -- Identity
    id              TEXT    PRIMARY KEY,
    project_id      TEXT    NOT NULL,
    name            TEXT    NOT NULL,

    -- Semantics (queried / joined / sorted)
    role            TEXT,                       -- 'source' | 'target' | 'dictionary' | 'translationNotes'
    kind            TEXT,                       -- 'codex' | 'usfm' | 'docx' | 'vtt' | ...
    book_code       TEXT,                       -- 'GEN', 'EXO', ...; null for non-scripture
    source_file_id  TEXT REFERENCES files(id),  -- target → paired source; null otherwise
    anchor_file_id  TEXT REFERENCES files(id),  -- ordering anchor in the project

    -- Projection mechanics (AD-2 chain head)
    event_id        TEXT    NOT NULL REFERENCES events(id),

    -- Rollup counters (advisory; recomputable from events)
    cell_count      INTEGER NOT NULL DEFAULT 0,
    approved_count  INTEGER NOT NULL DEFAULT 0,
    word_count      INTEGER NOT NULL DEFAULT 0,
    last_edit_at    INTEGER,

    -- Audit
    created_by      TEXT,                       -- username (matches events.author convention)
    created_at      INTEGER,
    updated_at      INTEGER,

    -- Sparse / schema-evolving (§"Column vs JSON meta"). Contents:
    --   r2_key, blob_sha, import_format, parser_version,
    --   source_language, target_language
    meta            TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_files_project      ON files(project_id);
CREATE INDEX idx_files_last_edit    ON files(project_id, last_edit_at);
CREATE INDEX idx_files_source_file  ON files(source_file_id) WHERE source_file_id IS NOT NULL;
CREATE INDEX idx_files_anchor_file  ON files(anchor_file_id) WHERE anchor_file_id IS NOT NULL;
CREATE INDEX idx_files_project_role ON files(project_id, role) WHERE role IS NOT NULL;

-- ── cell_validators ───────────────────────────────────────────────────

DROP INDEX IF EXISTS idx_validators_active;
DROP TABLE IF EXISTS cell_validators;

CREATE TABLE cell_validators (
    project_id      TEXT    NOT NULL,
    file_id         TEXT    NOT NULL,
    cell_id         TEXT    NOT NULL,
    event_id        TEXT    NOT NULL,           -- the validated target.cell.commit (event-anchored)
    username        TEXT    NOT NULL,           -- the validator
    decided_ts      INTEGER NOT NULL,
    PRIMARY KEY (project_id, file_id, cell_id, username)
) STRICT;

CREATE INDEX idx_cell_validators_cell ON cell_validators(project_id, file_id, cell_id);
