-- 0206_cell_audio_loudness.sql — AQU-2664: evening out the loudness of takes,
-- non-destructively.
--
-- Two facts on the clip, beside its volume (0193):
--
--   loudness_lufs     the recording's integrated loudness (ITU-R BS.1770),
--                     measured once in the browser; NULL = not measured yet;
--                     -70 = nothing above the silence gate.
--   true_peak_db      the recording's 4x oversampled true peak, dBTP.
--   loudness_from_ms  the window of the recording those two measured (a cut
--   loudness_to_ms    piece's, an import section's kept part; to NULL = the
--                     end). Each take is measured over its own window (Sam).
--                     All four written only by cell.audio.measure: a reading
--                     of the same window is a no-op, of another window it
--                     replaces the old one. A re-attach with a new url
--                     clears them (a new recording).
--   even_target_lufs  the loudness this take is evened out to; NULL = not
--                     evened out. Written only by cell.audio.even: evening
--                     out is its own stage, BEFORE the take's own volume and
--                     fades, and never writes gain_db or the fades (Sam).
--
-- The correction itself is never stored: the app works it out from these
-- (src/lib/audio/take-gain.ts) for playback and for every export, so the
-- recording never changes. No backfill: every take plays as it did.
-- Idempotent; a database loaded from schema.sql already has the columns.

ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS loudness_lufs REAL;
ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS true_peak_db REAL;
ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS loudness_from_ms BIGINT;
ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS loudness_to_ms BIGINT;
ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS even_target_lufs REAL;
