-- 0174_cell_audio_piece_of.sql — AQU-1767 phase 1: a take cut into pieces.
--
-- A cut makes a second cell_audio row over the SAME bytes (same url), with its
-- own audio_id, trim window, placement, label and votes — an independent piece
-- of audio that stays tied to the same row. `piece_of` names the take the
-- piece was cut from (the group's root). The root itself keeps NULL, so every
-- row that exists today is already a one-piece group and nothing is backfilled.
--
-- Group key = COALESCE(piece_of, audio_id). Selection is per GROUP: in one
-- (cell, slot, lane) either every live piece of a group is selected or none is
-- (cell.audio.attach / cell.audio.select deselect other groups, not other rows).
--
-- (0161 is taken by the org validation-count defaults on a sibling branch.)

ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS piece_of TEXT;
