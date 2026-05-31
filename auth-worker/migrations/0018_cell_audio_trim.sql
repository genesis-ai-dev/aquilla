-- Migration 0018: per-cell audio trim window
-- Adds non-destructive playback trim (start/end, milliseconds) to the
-- cell_audio projection so per-line slices of a shared clip — set via the crop
-- editor or "Voice together" — persist server-side and sync across devices.
-- Previously these lived only in client localStorage (audio-cell-prefs).
--
-- Additive + nullable: existing rows get NULL (= play the whole clip), so this
-- is non-breaking. cell_audio is not STRICT, so a bare ADD COLUMN is fine.
-- Applied to the shared aquilla-db D1 (same DB as snapshots/events).

ALTER TABLE cell_audio ADD COLUMN trim_start_ms INTEGER;
ALTER TABLE cell_audio ADD COLUMN trim_end_ms INTEGER;
