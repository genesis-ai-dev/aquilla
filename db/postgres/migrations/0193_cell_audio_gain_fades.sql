-- 0193_cell_audio_gain_fades.sql — AQU-2327: a take's volume and fades, as
-- data on the clip.
--
-- The Station (the media view's audio editing panel) sets a clip's volume and
-- its fade in and fade out. Like the trim, they never change the recording:
-- they are how this clip plays, kept beside `trim_start_ms`/`trim_end_ms`, and
-- the playback mixer and the exports apply them. Later work (evening out a
-- file's takes) sets the same `gain_db` automatically.
--
--   gain_db      the clip's volume in dB; NULL = as recorded (0 dB).
--   fade_in_ms   a straight-line fade in from the kept part's start; NULL = none.
--   fade_out_ms  a straight-line fade out to the kept part's end; NULL = none.
--
-- All three are written by `cell.audio.gain` only, which always states all
-- three (null clears). No backfill: every take before this plays as it did.
-- Idempotent; a database loaded from schema.sql already has the columns.
--
-- Numbered 0193: 0192 is in use on other branches. Files apply in name order.

ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS gain_db REAL;
ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS fade_in_ms BIGINT;
ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS fade_out_ms BIGINT;
