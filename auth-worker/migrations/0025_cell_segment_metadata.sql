-- Migration 0025: per-cell timeline-segment metadata
-- Timeline-segment-model (Scope A). Adds the segment fields that let one cell
-- model serve both subtitle (text) and audio/dub (media) tracks on a shared
-- timeline. All additive + nullable → non-breaking; existing rows get NULL,
-- which the client reads as medium='text' / no transcription / no camera tag.
--   medium         : 'text' | 'media' — primary content kind of the segment.
--   sequence_index : REAL (not INTEGER) — intrinsic order key; fractional so a
--                    segment can be inserted between two others (midpoint rank).
--   transcription  : ASR / corrected source text for a media clip.
--   camera_state   : 'on' | 'mixed' | 'off' — lip-sync constraint tag.
-- The file-level `orderedBy` lens lives in files.meta (JSON), not a column.
-- Applied to the shared aquilla-db D1.
ALTER TABLE cells ADD COLUMN medium TEXT;
ALTER TABLE cells ADD COLUMN sequence_index REAL;
ALTER TABLE cells ADD COLUMN transcription TEXT;
ALTER TABLE cells ADD COLUMN camera_state TEXT;
