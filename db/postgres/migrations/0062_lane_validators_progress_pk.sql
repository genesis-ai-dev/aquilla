-- 0062_lane_validators_progress_pk.sql
--
-- AQU-538 CONTRACT half for `cell_validators` and `file_section_progress`
-- (pairs with the EXPAND migration 0058). Promotes each primary key to the
-- 5-column lane form by attaching the unique indexes 0058 already built
-- (cell_validators_pkey5, file_section_progress_pkey5) — no rebuild, only a
-- brief catalog-level ACCESS EXCLUSIVE lock per table.
--
-- RUN ONLY AFTER the lane-aware workers are deployed and the old version has
-- drained (same ordering rule as 0061). Guarded + idempotent: once target_lang
-- is in a table's PK, that block no-ops (clean no-op on fresh DBs too).
--
-- NOT applied automatically to live Neon branches. Apply by hand:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0062_lane_validators_progress_pk.sql
-- Verify: the cell_validators and file_section_progress PK definitions both
-- list target_lang.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'cell_validators'::regclass
      AND i.indisprimary
      AND a.attname = 'target_lang'
  ) THEN
    ALTER TABLE cell_validators DROP CONSTRAINT cell_validators_pkey;
    ALTER TABLE cell_validators ADD CONSTRAINT cell_validators_pkey PRIMARY KEY USING INDEX cell_validators_pkey5;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'file_section_progress'::regclass
      AND i.indisprimary
      AND a.attname = 'target_lang'
  ) THEN
    ALTER TABLE file_section_progress DROP CONSTRAINT file_section_progress_pkey;
    ALTER TABLE file_section_progress ADD CONSTRAINT file_section_progress_pkey PRIMARY KEY USING INDEX file_section_progress_pkey5;
  END IF;
END $$;
