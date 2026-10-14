-- 0169_lanes_records_audio.sql — AQU-1954 "Records audio", per language
--
-- One switch on each target language's row (Project settings → Languages).
-- On, every file owes audio in that language: the plan board expects it of
-- every book, and the language's audio numbers divide by every file. Off (the
-- default), a file counts that language's audio only once it has a recording
-- in that language, which is what the plan board already measured.
--
-- A constant default, so Postgres adds the column without rewriting the table.
--
-- Idempotent. A database loaded from schema.sql already has the column.
ALTER TABLE lanes
  ADD COLUMN IF NOT EXISTS records_audio BOOLEAN NOT NULL DEFAULT false;
