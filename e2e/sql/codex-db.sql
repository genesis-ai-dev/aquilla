-- Migration: 0001_initial_codex_schema.sql
-- Description: Product-specific read projection for codex-web-app.
-- Written by the sync DO on onSave (debounced) and on alarm/last-disconnect compaction.
-- Canonical state lives in R2 snapshots; this table is always derivable from them.

-- File-level rollup.
-- last_edit_at is Y.Doc-derived (ms since epoch from cell history entries),
-- NOT CURRENT_TIMESTAMP, so it's idempotent across DO restarts and retries.
CREATE TABLE files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    source_language TEXT,
    target_language TEXT,
    cell_count INTEGER NOT NULL DEFAULT 0,
    approved_count INTEGER NOT NULL DEFAULT 0,
    word_count INTEGER NOT NULL DEFAULT 0,
    last_edit_at INTEGER,
    projected_from TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_files_project ON files(project_id);
CREATE INDEX idx_files_last_edit ON files(project_id, last_edit_at);

-- Per-cell projection.
-- UPSERT discipline: writes guard on last_edit_at so out-of-order writes are rejected.
--   INSERT INTO cells (...) VALUES (...)
--   ON CONFLICT(file_id, cell_id) DO UPDATE SET ...
--   WHERE excluded.last_edit_at > cells.last_edit_at;
-- Full reconcile on DO compaction always replays from the R2 snapshot.
CREATE TABLE cells (
    file_id TEXT NOT NULL,
    cell_id TEXT NOT NULL,
    content_text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    validated INTEGER NOT NULL DEFAULT 0,
    word_count INTEGER NOT NULL DEFAULT 0,
    last_editor TEXT,
    last_edit_at INTEGER NOT NULL,
    projected_from TEXT,
    PRIMARY KEY (file_id, cell_id),
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX idx_cells_last_edit ON cells(file_id, last_edit_at);
CREATE INDEX idx_cells_validated ON cells(file_id, validated);

-- FTS5 over cell content for literal substring search (dashboards, filter UIs).
-- NOT for semantic similarity — that's Vectorize, separate index.
CREATE VIRTUAL TABLE cells_fts USING fts5(
    content_text,
    content='cells',
    content_rowid='rowid'
);

CREATE TRIGGER cells_fts_insert AFTER INSERT ON cells BEGIN
    INSERT INTO cells_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
END;

CREATE TRIGGER cells_fts_delete AFTER DELETE ON cells BEGIN
    INSERT INTO cells_fts(cells_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
END;

CREATE TRIGGER cells_fts_update AFTER UPDATE ON cells BEGIN
    INSERT INTO cells_fts(cells_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
    INSERT INTO cells_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
END;

-- Named checkpoints for disaster recovery / snapshots.
-- r2_key points into R2 at projects/{project_id}/files/{file_id}/checkpoints/{id}.bin
CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    label TEXT,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    r2_key TEXT NOT NULL,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX idx_checkpoints_file ON checkpoints(file_id, created_at);
CREATE INDEX idx_checkpoints_project ON checkpoints(project_id, created_at);

-- Migration: 0002_events_and_validators.sql
-- Description: Append-only event log and cell-validator projection for codex CQRS Phase 0.
--
-- WHY an event log?
--   The existing `cells` and `files` tables are last-write-wins projections derived from
--   R2 snapshots via the sync DO.  They answer "what is the current state?" but cannot
--   answer "who validated this version?" or "what was the sequence of edits this session?"
--   An append-only `events` table provides an auditable, replayable source of truth for
--   state changes that the projection tables deliberately discard.
--
-- WHY client-generated UUIDv7 for `id`?
--   UUIDv7 embeds a millisecond-precision timestamp in the high bits, giving time-ordered
--   inserts without a server sequence.  Clients can generate the PK offline, enabling
--   optimistic local writes that are idempotent on server ingestion (INSERT OR IGNORE).
--
-- WHY both client_ts and server_ts?
--   client_ts is used for last-write-wins (LWW) resolution in projections: two clients
--   racing to validate the same cell resolve by whichever carry the larger client_ts.
--   server_ts is the authoritative ordering column for pagination and fanout queries;
--   it never goes backwards even when client clocks drift.
--
-- WHY project_id on events (and not just on files)?
--   Cross-file queries — "all events by author X across project Y", "all validations
--   in a project since timestamp T" — require project_id directly on the row.  Joining
--   through `files` on every such query would be expensive and fragile if a file is
--   later deleted.
--
-- WHY no foreign keys on events?
--   Events are the source of truth; the projection tables (`files`, `cells`) are derived
--   from them.  Making events reference projections would invert the dependency and block
--   out-of-order ingestion.  The existing `cells` → `files` FK is safe because both
--   sides are projections written together; events stand alone.

CREATE TABLE events (
    id              TEXT PRIMARY KEY,       -- client-generated UUIDv7 (time-sortable, idempotent)
    schema_version  INTEGER NOT NULL,       -- bump when payload shape changes to allow migration logic
    project_id      TEXT NOT NULL,
    file_id         TEXT,                   -- NULL for project-level events (e.g. project.settings.changed)
    cell_id         TEXT,                   -- NULL for file-level events (e.g. file.imported)
    kind            TEXT NOT NULL,          -- 'cell.commit' | 'cell.validate' | 'cell.unvalidate' | etc.
    author          TEXT NOT NULL,          -- frontier username of the acting user
    payload         TEXT NOT NULL,          -- JSON blob; shape is kind-specific and versioned by schema_version
    client_ts       INTEGER NOT NULL,       -- client clock in ms since epoch; used for LWW projection writes
    server_ts       INTEGER NOT NULL        -- server clock in ms since epoch; authoritative for ordering/pagination
) STRICT;

-- Hot path: fetch ordered history for a single cell (translation review, diff view).
CREATE INDEX idx_events_cell    ON events(project_id, file_id, cell_id, server_ts);

-- Hot path: project-wide event feed (dashboard activity stream, fanout to collaborators).
CREATE INDEX idx_events_project ON events(project_id, server_ts);

-- Audit / author-scoped queries: "show me everything I've done across my projects".
CREATE INDEX idx_events_author  ON events(author, server_ts);

-- Per-(cell, edit-version, user) validator state.
--
-- WHY a separate projection and not just a query over events?
--   Scanning all 'cell.validate' events on every cell read would require a full index
--   scan plus aggregation.  This table pre-aggregates to a single row per (cell, version,
--   user) so the hot read path ("is this cell approved?") is a single key lookup.
--
-- WHY edit_event_id in the PK?
--   A validator decision is tied to a specific version of the cell content.  If the cell
--   is edited after validation the old approval must not carry forward; including the
--   edit event's id in the PK naturally scopes each decision to the version it was made
--   against.  Querying "all active validators for the current version" just filters on
--   the current edit_event_id.
--
-- WHY is_active instead of deleting rows?
--   Deletions break the audit trail.  Marking a row inactive (is_active = 0) preserves
--   history while the partial index below makes the active-only read path cheap.
--
-- UPSERT discipline: writes guard on decided_ts for LWW resolution.
--   INSERT INTO cell_validators (...) VALUES (...)
--   ON CONFLICT(project_id, file_id, cell_id, edit_event_id, username)
--   DO UPDATE SET is_active = excluded.is_active, decided_ts = excluded.decided_ts
--   WHERE excluded.decided_ts > cell_validators.decided_ts;

CREATE TABLE cell_validators (
    project_id      TEXT NOT NULL,
    file_id         TEXT NOT NULL,
    cell_id         TEXT NOT NULL,
    edit_event_id   TEXT NOT NULL,          -- FK (logical) to events.id for the cell version being validated
    username        TEXT NOT NULL,          -- frontier username of the validator
    is_active       INTEGER NOT NULL,       -- 1 = approval stands, 0 = revoked or superseded
    decided_ts      INTEGER NOT NULL,       -- client_ts of the deciding event; used for LWW conflict resolution
    PRIMARY KEY (project_id, file_id, cell_id, edit_event_id, username)
) STRICT;

-- Partial index: only index the rows that matter for the approval hot path.
-- "Is this cell version approved, and by whom?" scans only active rows per cell.
-- D1 supports partial indexes; the WHERE clause keeps this index small even as
-- revoked decisions accumulate over time.
CREATE INDEX idx_validators_active ON cell_validators(project_id, file_id, cell_id)
    WHERE is_active = 1;

-- Migration: 0003_cells_edit_count.sql
-- Description: Add cells.edit_count for the CQRS audit-stats read endpoint.
--
-- The CQRS write path (sync-worker/src/events/event-projection.ts, cell.commit
-- handler) increments this counter under the same LWW guard as content_text /
-- last_edit_at, so out-of-order replays don't double-count. The Y.Doc
-- projection path (sync-worker/src/projection.ts, writeProjection) preserves
-- the existing value when reprojecting from snapshot — the count is owned by
-- the events stream, not the Y.Doc.
--
-- New cells get edit_count = 0 from both write paths (NOT NULL DEFAULT 0).
-- Existing rows pre-migration default to 0; the actual count is recoverable
-- by replaying events via /admin/projects/:id/rebuild-projection.
--
-- Read path: GET /cells/audit-stats?fileId= returns
-- { cells: [{ cellId, editCount, contentHash }] }, consumed by client UI
-- code (Phase 3) that previously read history.length from the Y.Doc.

ALTER TABLE cells ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0;
