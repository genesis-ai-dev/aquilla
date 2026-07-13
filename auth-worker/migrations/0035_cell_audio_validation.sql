-- Migration 0035: per-cell audio validation (AQU-508).
--
-- Adds audio approval to the cell_audio projection, distinct from text
-- validation (cells.validated). A reviewer approves the currently-selected clip
-- via the cell.audio.validate event; cell.audio.unvalidate clears it. The
-- portfolio rollup counts cells whose selected, live clip is approved into
-- `validatedAudioCells` (see auth-worker src/services/org-permissions.ts),
-- unblocking the audio-validation % on the Overview (AQU-490).
--
-- Additive + defaulted, so existing rows are "not yet audio-validated"
-- (approved = 0) — non-breaking. cell_audio is STRICT; ADD COLUMN with an
-- explicit type + NOT NULL DEFAULT is allowed. Applied to the shared aquilla-db
-- D1 (same DB as snapshots/events).

ALTER TABLE cell_audio ADD COLUMN approved    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cell_audio ADD COLUMN approved_by TEXT;
ALTER TABLE cell_audio ADD COLUMN approved_ts INTEGER;
