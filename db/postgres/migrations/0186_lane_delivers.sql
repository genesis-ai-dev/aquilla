-- 0186_lane_delivers.sql — media redesign slice 1: each target language says
-- what it DELIVERS (Text, Audio, or Text and audio), and the counting follows it.
--
-- `lanes.delivers` is the choice on each row of Project settings → Languages,
-- replacing the "Records audio" switch (0173, AQU-1954). NULL means NOT CHOSEN
-- YET, which a second boolean could not say: such a language counts exactly as
-- it did before this column existed (src/lib/lanes/lane-delivers.ts).
--
-- No existing language changes its numbers here (Sam, Oct 22):
--   * "Records audio" OFF reads as Text. Text IS today's counting, so this
--     moves nothing.
--   * "Records audio" ON stays NULL until Sam picks Text or Text and audio for
--     it from a production list before this ships. Until then it counts as
--     today, and its row asks for a choice.
-- Choosing writes `records_audio` too (Audio and Text and audio owe audio on
-- every file), so the existing readers of that column stay correct untouched.
--
-- New rows default to Text, which is what the create dialog starts each
-- language at. The default is set AFTER the backfill: as part of ADD COLUMN it
-- would fill every existing row, the "Records audio" ones included.
--
-- `file_section_progress.text_audio_validator_histogram` is what lets "Text and
-- audio" count a line done only when both halves are, ON THE SAME LINE: one
-- key per (text votes, audio votes) pair, over the lines that have a
-- recording, read at the project's two thresholds like every other validator
-- histogram. Plus its structural share, as for the others. A constant default,
-- so Postgres adds both without rewriting the table. A row recomputed before
-- this deploy reads '{}' while its audio histogram is not empty; the progress
-- backfill's `--text-and-audio` flag re-projects exactly those files.
--
-- Idempotent. A database loaded from schema.sql already has the columns.
ALTER TABLE lanes
  ADD COLUMN IF NOT EXISTS delivers TEXT
    CHECK (delivers IS NULL OR delivers IN ('text', 'audio', 'text_and_audio'));

UPDATE lanes
   SET delivers = 'text'
 WHERE role = 'target' AND delivers IS NULL AND records_audio = false;

ALTER TABLE lanes ALTER COLUMN delivers SET DEFAULT 'text';

ALTER TABLE file_section_progress
  ADD COLUMN IF NOT EXISTS text_audio_validator_histogram JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS structural_text_audio_validator_histogram JSONB NOT NULL DEFAULT '{}'::jsonb;
