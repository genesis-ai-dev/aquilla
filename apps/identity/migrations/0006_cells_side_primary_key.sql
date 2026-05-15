-- Migration: 0006_cells_side_primary_key.sql
-- Description: Rebuild the cells projection so source and target rows can
-- coexist for the same imported file/cell. This app is in the AD-2 rewrite
-- path, so the projection can be regenerated from events after deployment.

DROP TRIGGER IF EXISTS cells_fts_insert;
DROP TRIGGER IF EXISTS cells_fts_delete;
DROP TRIGGER IF EXISTS cells_fts_update;
DROP TABLE IF EXISTS cells_fts;
DROP TABLE IF EXISTS cells;

CREATE TABLE cells (
    project_id      TEXT    NOT NULL,
    file_id         TEXT    NOT NULL,
    cell_id         TEXT    NOT NULL,
    side            TEXT    NOT NULL CHECK (side IN ('source', 'target')),
    value           TEXT    NOT NULL,
    value_html      TEXT,
    type            TEXT,
    canonical_ref   TEXT,
    anchor_cell_id  TEXT,
    event_id        TEXT    NOT NULL,
    source_event_id TEXT,
    last_editor     TEXT,
    last_edit_at    INTEGER NOT NULL,
    validated       INTEGER NOT NULL DEFAULT 0,
    word_count      INTEGER NOT NULL DEFAULT 0,
    content_hash    TEXT,
    PRIMARY KEY (project_id, file_id, cell_id, side),
    FOREIGN KEY (event_id) REFERENCES events(id),
    FOREIGN KEY (source_event_id) REFERENCES events(id)
);

CREATE INDEX idx_cells_file_order ON cells(project_id, file_id, side, anchor_cell_id);
CREATE INDEX idx_cells_source_basis ON cells(source_event_id);
CREATE INDEX idx_cells_validated ON cells(project_id, file_id, side, validated);
CREATE INDEX idx_cells_last_edit ON cells(project_id, file_id, side, last_edit_at);

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
