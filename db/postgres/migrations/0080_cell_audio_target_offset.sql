-- 0080_cell_audio_target_offset.sql — AQU-646 stage 3: a take's own placement.
--
-- Where a dub sits against the line it performs has always lived on the CELL,
-- in `cells.metadata.target_offset_ms`. That was exact while a line could hold
-- only one dub. It stops being exact the moment extra target-audio tracks
-- exist: two takes on one line would share a single anchor, so dragging one
-- chip would move the other.
--
-- So the anchor moves onto the take. Written only by `cell.audio.place`, which
-- is its own event kind and never rides an attach — absence has to keep meaning
-- one thing.
--
-- NULL means "not placed by hand", NOT "placed at zero": zero is a legal,
-- common offset. Every reader keeps the existing `!= null` discipline, and
-- falls back to the cell's metadata for the many takes that predate this
-- column, which is permanent rather than a migration step — `rebuild.ts`
-- replays historical `cell.lane.retime` events into `cells.metadata` forever.

ALTER TABLE cell_audio ADD COLUMN IF NOT EXISTS target_offset_ms BIGINT;
