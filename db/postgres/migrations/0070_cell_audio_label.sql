-- 0070_cell_audio_label.sql — AQU-646 round 8: takes get PERMANENT names.
--
-- `label` is a take's display identity ("Take 3", or a user rename) — set at
-- attach time, changed only by cell.audio.rename. Never derived from list
-- position, so deleting a take can't renumber the rest.

ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS label TEXT;
