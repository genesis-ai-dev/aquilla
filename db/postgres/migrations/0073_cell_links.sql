-- 0073_cell_links.sql — AQU-646 stage 4: links between the two cue lists.
--
-- An episode of The Chosen ships two cue lists. The SUBTITLE VTT is what gets
-- translated; the AUDIO VTT is a near-verbatim transcript of what is actually
-- heard, and it is what the picture demands when recording. They deliberately
-- disagree — subtitles are condensed for reading, dub lines are cut for the
-- mouth — so on episode 101, 93 subtitle cells are performed as two or more
-- heard lines and 154 heard lines span two or more subtitle rows.
--
-- A link is therefore a MANY-TO-MANY pairwise edge, and utterance clusters are
-- simply what the edges connect. There is no group object, and adding one
-- later would mean keeping it consistent with the edges for no gain.
--
-- Written by the cell.link.set event (see events/event-projection.ts). Read
-- per-file via GET /api/v1/projects/:projectId/files/:fileId/cell-links.
--
-- THE ENDPOINTS ARE THE PRIMARY KEY. That makes the event idempotent for free:
-- re-delivery, or a replay of the whole event log, lands on the same row
-- instead of accumulating duplicate edges, and no id has to be minted.
--
-- UNLINKING IS A TOMBSTONE (`linked = 0`), NOT A DELETED ROW. The auto-linker
-- writes ~650 events at import; if an unlink deleted the row, replaying that
-- import event afterwards would resurrect an edge a person had deliberately
-- removed. `linked` is also NOT NULL and always written — the stage 4.5 data
-- loss came from one field meaning both "clear this" and "no opinion".

CREATE TABLE cell_links (
    project_id   TEXT    NOT NULL,
    -- Edge type. 'text-audio' is the only one today; the untimed "pocket bin"
    -- adds its own over this same table, which is why it is a column and not
    -- an assumption.
    kind         TEXT    NOT NULL,
    -- The SUBTITLE side — the event envelope's fileId/cellId.
    from_file_id TEXT    NOT NULL,
    from_cell_id TEXT    NOT NULL,
    -- The AUDIO CUE side, in the hidden `role: 'audio-cues'` sibling file.
    to_file_id   TEXT    NOT NULL,
    to_cell_id   TEXT    NOT NULL,
    linked       INTEGER NOT NULL DEFAULT 1,
    -- 'auto' = the import-time linker, 'manual' = a person. Kept so a later
    -- round can offer "reset the pairings nobody has touched" without guessing.
    origin       TEXT    NOT NULL,
    -- The linker's score. Diagnostic only — nothing reads it to decide.
    confidence   REAL,
    event_id     TEXT    NOT NULL,
    -- When the edge FIRST appeared; survives every later toggle of the pair.
    created_ts   BIGINT  NOT NULL,
    PRIMARY KEY (project_id, kind, from_file_id, from_cell_id, to_file_id, to_cell_id)
);

-- The read route asks for every live edge touching one file, and a file is on
-- one side or the other depending on whether it is the subtitles or the cues,
-- so both directions are indexed.
CREATE INDEX idx_cell_links_from ON cell_links (project_id, from_file_id) WHERE linked = 1;
CREATE INDEX idx_cell_links_to   ON cell_links (project_id, to_file_id)   WHERE linked = 1;
