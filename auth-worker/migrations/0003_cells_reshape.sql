-- Migration: 0003_cells_reshape.sql
-- Description: Destructive reshape of the cells projection table to match
--   spec 03-data-model.md "Indicative schemas". The new shape carries:
--     - project_id, file_id, cell_id as a composite PK (paired source/target
--       cells share a cell_id but live in separate files, so the file_id is
--       still part of the key)
--     - side  — 'source' | 'target'. The same cell_id can have rows on both
--       sides in different files.
--     - value, value_html — translation/source content (was: content_text)
--     - type, canonical_ref — cell typing (verse/header/footnote), e.g.
--       "GEN 1:1" for scripture
--     - anchor_cell_id — ordering anchor (was: implicit by `order` Y.Array)
--     - event_id — AD-2: id of the most recent winning event on this row
--     - source_event_id — AD-9: target-side staleness pin (UUIDv7 of the
--       source cell's event_id observed at commit time)
--     - last_editor, last_edit_at, validated, word_count — unchanged
--     - content_hash — kept for FTS short-circuit on unchanged cells
--
-- No users yet (project_no_users_yet memory) so a clean DROP + CREATE is
-- safe. There is no migration of existing cell rows — the previous schema
-- can't express side/value/anchor without ambiguity, and the new event log
-- (0002 + per-kind events in 0004) is the load path going forward.

DROP TRIGGER IF EXISTS cells_fts_insert;
DROP TRIGGER IF EXISTS cells_fts_delete;
DROP TRIGGER IF EXISTS cells_fts_update;
DROP TABLE IF EXISTS cells_fts;
DROP TABLE IF EXISTS cells;

CREATE TABLE cells (
    project_id      TEXT    NOT NULL,
    file_id         TEXT    NOT NULL,
    cell_id         TEXT    NOT NULL,           -- UUIDv7 (paired source/target share this id)
    side            TEXT    NOT NULL CHECK (side IN ('source', 'target')),
    value           TEXT    NOT NULL,
    value_html      TEXT,
    type            TEXT,
    canonical_ref   TEXT,                       -- 'GEN 1:1' for scripture, null otherwise
    anchor_cell_id  TEXT,                       -- ordering anchor; null on first cell
    event_id        TEXT    NOT NULL,           -- AD-2: most recent winning event on this row
    source_event_id TEXT,                       -- AD-9: target side only; staleness pin
    last_editor     TEXT,
    last_edit_at    INTEGER NOT NULL,
    validated       INTEGER NOT NULL DEFAULT 0,
    word_count      INTEGER NOT NULL DEFAULT 0,
    content_hash    TEXT,                       -- djb2; cheap FTS short-circuit fingerprint
    PRIMARY KEY (project_id, file_id, cell_id),
    FOREIGN KEY (event_id) REFERENCES events(id),
    FOREIGN KEY (source_event_id) REFERENCES events(id)
);

-- Walk-the-anchor-chain ordering inside a file.
CREATE INDEX idx_cells_file_order ON cells(project_id, file_id, anchor_cell_id);

-- "Which target cells pin this source event?" — supports AD-9 staleness
-- queries and reverse lookups when a source advances.
CREATE INDEX idx_cells_source_basis ON cells(source_event_id);

-- Existing query patterns from the read routes also benefit from a couple
-- of secondary indexes; kept minimal to avoid write amplification.
CREATE INDEX idx_cells_validated ON cells(project_id, file_id, validated);
CREATE INDEX idx_cells_last_edit ON cells(project_id, file_id, last_edit_at);

-- FTS5 over `value` for literal substring search (was: content_text).
-- content/content_rowid tie the FTS index to the base table so triggers
-- below keep it in sync.
CREATE VIRTUAL TABLE cells_fts USING fts5(
    value,
    content='cells',
    content_rowid='rowid'
);

CREATE TRIGGER cells_fts_insert AFTER INSERT ON cells BEGIN
    INSERT INTO cells_fts(rowid, value) VALUES (new.rowid, new.value);
END;

CREATE TRIGGER cells_fts_delete AFTER DELETE ON cells BEGIN
    INSERT INTO cells_fts(cells_fts, rowid, value) VALUES ('delete', old.rowid, old.value);
END;

CREATE TRIGGER cells_fts_update AFTER UPDATE ON cells BEGIN
    INSERT INTO cells_fts(cells_fts, rowid, value) VALUES ('delete', old.rowid, old.value);
    INSERT INTO cells_fts(rowid, value) VALUES (new.rowid, new.value);
END;
