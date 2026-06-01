-- 0021_cell_backtranslations.sql
-- Persisted back-translations projected from cell.backtranslation.set events.
--
-- One row per (project_id, file_id, cell_id, target_event_id). The latest row
-- per (project_id, file_id, cell_id) — the one with the highest created_at —
-- is the current BT for display. Rows are keyed by target_event_id so stale
-- and historical BTs remain queryable.
--
-- This table is NON-CHAIN-MUTATING: writing a BT does NOT move cells.event_id
-- and does NOT affect cell_validators or endorsement_count.
--
-- Written by: cell.backtranslation.set events (sync-worker event-projection.ts).
-- Read by:    GET /api/v1/projects/:projectId/files/:fileId/backtranslations.
--
-- `target_event_id` pins the BT to the target cell commit it was generated
-- from. A BT is "stale" when its target_event_id no longer matches the cell's
-- current cells.event_id (the target has been re-edited since the BT was made).
-- The client detects staleness by comparing the returned targetEventId against
-- cells.eventId without a second round-trip.
--
-- `polished` flags that an LLM polish pass was applied (shows a "polished"
-- badge in the UI per the ai-copilot spec). Statistical-only BTs have polished=0.

CREATE TABLE cell_backtranslations (
    project_id      TEXT    NOT NULL,
    file_id         TEXT    NOT NULL,
    cell_id         TEXT    NOT NULL,
    target_event_id TEXT    NOT NULL,   -- target.cell.commit / target.cell.create event_id
    bt_text         TEXT    NOT NULL,   -- plain-text back-translation
    bt_html         TEXT,               -- optional rich/HTML rendering
    polished        INTEGER NOT NULL DEFAULT 0,  -- 1 = LLM-polished; 0 = statistical-only
    author          TEXT    NOT NULL,   -- username who set/corrected this BT
    event_id        TEXT    NOT NULL,   -- the cell.backtranslation.set event that wrote this row
    server_seq      INTEGER,            -- per-project monotonic sequence from the event row
    created_at      INTEGER NOT NULL,   -- server_ts of the cell.backtranslation.set event (unix ms)
    PRIMARY KEY (project_id, file_id, cell_id, target_event_id)
) STRICT;

-- Per-file read: fetch all latest BTs for a file in one query.
CREATE INDEX idx_cell_bt_file ON cell_backtranslations(project_id, file_id);

-- Per-cell lookup: quickly find the latest BT for a single cell.
CREATE INDEX idx_cell_bt_cell ON cell_backtranslations(project_id, file_id, cell_id, created_at DESC);
