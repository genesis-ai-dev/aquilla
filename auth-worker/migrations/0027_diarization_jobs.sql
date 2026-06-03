-- Migration 0027: speaker-diarization async jobs
-- Operational state for the Modal-hosted pyannote diarization flow (design:
-- docs/superpowers/specs/2026-06-03-diarization-modal-pyannote-design.md). The
-- durable RESULT (media segments + cast) lands in the cell event log when the
-- client applies the turns; this table only tracks the async job lifecycle and
-- holds the raw turns until applied.
--   status        : 'queued' | 'running' | 'succeeded' | 'failed'
--   audio_object   : R2 object name (the media clip's audioId incl. extension)
--   fetch_token    : random token gating the Modal-facing audio-fetch URL
--   turns_json     : JSON [{startMs,endMs,speaker}] once succeeded
--   num_speakers   : optional caller hint (NULL = auto-detect)
-- Applied to the shared aquilla-db D1.
CREATE TABLE IF NOT EXISTS diarization_jobs (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    file_id       TEXT NOT NULL,
    audio_object  TEXT NOT NULL,
    fetch_token   TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued',
    num_speakers  INTEGER,
    turns_json    TEXT,
    error         TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diarization_jobs_file ON diarization_jobs(project_id, file_id);
