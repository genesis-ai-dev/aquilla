-- Migration 003: per-attachment word-level audio timings.
-- Edit-keyed via (cell_id, cell_version_at, text_snapshot) so timings
-- generated for an older translation stay queryable as historical context.
-- See DATA_PERSISTENCE_PLAN.md §4.10–§4.12 (cell-keyed vs edit-keyed)
-- and EDITOR_REFACTOR_CHECKLIST.md Phase F.7.
--
-- The legacy shape is `Record<attachmentId, WordTiming[]>` per cell —
-- one timings array per attachment, recorded once when the audio was
-- generated/aligned. We store the array as a single JSON blob (rather
-- than a row-per-word table) because:
--   - Timings are read as a unit by the karaoke renderer
--   - Word counts are bounded (cell-sized text)
--   - Storage and indexing stay simple

CREATE TABLE audio_timings (
  attachment_id    TEXT PRIMARY KEY,
  cell_id          TEXT NOT NULL,
  cell_version_at  INTEGER NOT NULL,
  text_snapshot    TEXT NOT NULL,
  -- WordTiming[] serialized: [{word, t0, t1, start, end}, …]. t0/t1 in
  -- seconds; start/end are inclusive/exclusive char offsets into
  -- text_snapshot at recording time.
  timings_json     TEXT NOT NULL,
  generated_by     TEXT NOT NULL,
  generated_at     INTEGER NOT NULL,
  seq              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_audio_timings_cell ON audio_timings(cell_id, cell_version_at);
