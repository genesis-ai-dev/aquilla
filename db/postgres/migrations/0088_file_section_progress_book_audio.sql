-- AQU-1093/1096/1098: book-grain rows, audio counts, and per-unit activity on
-- the progress projection.
--
-- The project dashboard plans by UNIT: a file normally, but a Bible book where
-- a file subdivides into books. Book totals were computed client-side by
-- re-parsing every chapter section; the dashboard needs them server-side so the
-- org rollup can count them without shipping the whole tree.
--
-- Three additions, all backwards-compatible:
--   * scope gains 'book'. Every existing reader filters by scope ('file' in the
--     files list and the portfolio lane rollup, 'section' in the drill-down),
--     so book rows are invisible to code that does not ask for them.
--   * audio_count / audio_validated_count. Audio progress existed only as one
--     project-wide number from the org portfolio; per-file and per-book was
--     unreachable. Definitions match that portfolio query exactly — a cell
--     counts as having audio when ANY live take exists, and as validated when
--     its SELECTED take is approved — so the tiles and the rows can never
--     disagree.
--   * last_edit_at. "Which units are being worked on right now" needs an
--     activity time per unit; files.last_edit_at is per FILE and cannot answer
--     it for a 66-book import.
--
-- ADD COLUMN with a constant default is metadata-only. The CHECK swap takes a
-- brief ACCESS EXCLUSIVE lock to scan the table, which holds one row per
-- (file, section, lane) — seconds, not minutes.
--
-- The two CHECKs 0053 created inline were auto-named by Postgres
-- (file_section_progress_scope_check, file_section_progress_check). They are
-- dropped by DEFINITION rather than by name so this is safe on a database
-- where they were named differently, and re-added with explicit names so
-- scripts/neon-schema-contract.ts can verify the migration actually ran.

ALTER TABLE file_section_progress ADD COLUMN IF NOT EXISTS audio_count           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE file_section_progress ADD COLUMN IF NOT EXISTS audio_validated_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE file_section_progress ADD COLUMN IF NOT EXISTS last_edit_at          BIGINT;

DO $$
DECLARE c RECORD;
BEGIN
  -- Drop any scope/shape CHECK that predates 'book'.
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'file_section_progress'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%scope%'
       AND pg_get_constraintdef(oid) NOT ILIKE '%book%'
  LOOP
    EXECUTE format('ALTER TABLE file_section_progress DROP CONSTRAINT %I', c.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'file_section_progress'::regclass
       AND conname = 'file_section_progress_scope_check'
  ) THEN
    ALTER TABLE file_section_progress
      ADD CONSTRAINT file_section_progress_scope_check
      CHECK (scope IN ('file', 'section', 'book'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'file_section_progress'::regclass
       AND conname = 'file_section_progress_shape_check'
  ) THEN
    ALTER TABLE file_section_progress
      ADD CONSTRAINT file_section_progress_shape_check
      CHECK (
        (scope = 'file' AND section_key = '') OR
        (scope IN ('section', 'book') AND section_key <> '')
      );
  END IF;


  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'file_section_progress'::regclass
       AND conname = 'file_section_progress_audio_count_check'
  ) THEN
    ALTER TABLE file_section_progress
      ADD CONSTRAINT file_section_progress_audio_count_check CHECK (audio_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'file_section_progress'::regclass
       AND conname = 'file_section_progress_audio_validated_count_check'
  ) THEN
    ALTER TABLE file_section_progress
      ADD CONSTRAINT file_section_progress_audio_validated_count_check CHECK (audio_validated_count >= 0);
  END IF;
END $$;
