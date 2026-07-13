-- Migration 0052: per-cell audio validation (AQU-508).
--
-- Audio validation was conflated with text validation: `cells.validated` is a
-- single boolean shared by both media, and `cell_audio` had no approval column,
-- so the Overview could only report audio *coverage* ("Has Audio"), never audio
-- *validation*. This adds the missing per-clip approval signal that the
-- portfolio rollup counts into `validatedAudioCells`, unblocking AQU-490.
--
-- Set by the cell.audio.validate / cell.audio.unvalidate event kinds
-- (sync-worker src/events/event-projection.ts); a reviewer approves the
-- currently-selected clip. Additive + defaulted, so existing rows are simply
-- "not yet audio-validated" (approved = 0) — non-breaking.

ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS approved    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS approved_ts BIGINT;
