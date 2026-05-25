-- 0014_cell_audio.sql
-- Durable per-cell audio attachments (AD-2 audio grammar).
--
-- Re-establishes the cell→audio link that Phase 2c-γ removed, now projected
-- from the append-only event log instead of per-file Y.Doc handles. One row
-- per (cell, audio_id). `slot` separates human recordings from generated/cloned
-- voice; `selected` marks the active clip within a slot; `deleted` is a
-- soft-delete tombstone so history/audit can still see removed clips.
--
-- Written by the cell.audio.attach / cell.audio.select / cell.audio.remove
-- event kinds (sync-worker src/events/event-projection.ts). Read per-file via
-- GET /api/v1/projects/:projectId/files/:fileId/audio-attachments.
--
-- The R2 bytes themselves live under projects/{projectId}/files/{fileId}/audio/
-- (recordings + generated voice) addressed by the frontier-audio:// url; this
-- table only holds the metadata + selection state.

CREATE TABLE cell_audio (
    project_id          TEXT    NOT NULL,
    file_id             TEXT    NOT NULL,
    cell_id             TEXT    NOT NULL,
    audio_id            TEXT    NOT NULL,           -- object name incl. ext (e.g. audio-x.wav)
    slot                TEXT    NOT NULL,           -- 'recording' | 'generatedVoice'
    url                 TEXT    NOT NULL,           -- frontier-audio://<id>.<ext>
    mime_type           TEXT,
    voice_id            TEXT,                        -- Voice library id (generated/cloned)
    reference_audio_id  TEXT,                        -- clone reference clip id, if cloned
    duration_ms         INTEGER,
    timings_json        TEXT,                        -- Whisper word timings, JSON
    selected            INTEGER NOT NULL DEFAULT 0,  -- 1 = active clip in its slot
    deleted             INTEGER NOT NULL DEFAULT 0,  -- 1 = soft-deleted
    event_id            TEXT    NOT NULL,            -- the cell.audio.attach event
    created_ts          INTEGER NOT NULL,
    PRIMARY KEY (project_id, file_id, cell_id, audio_id)
) STRICT;

-- Per-file read (the editor / Voice Studio pull all live attachments at once).
CREATE INDEX idx_cell_audio_file ON cell_audio(project_id, file_id) WHERE deleted = 0;
