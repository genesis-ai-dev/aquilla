-- aqu538-99-contract.sql — PHASE 2 (contract): promote the 5-column lane keys
-- to PRIMARY KEY, retiring the old 4-column PKs.
--
-- RUN ONLY AFTER:
--   1. aqu538-00-expand.sql has been applied, AND
--   2. the three `*_pkey5` unique indexes were built CONCURRENTLY and are VALID
--      (see the runbook — verify with the indisvalid query), AND
--   3. the new lane-aware workers are fully deployed and the old version has
--      drained (the old 4-col `ON CONFLICT` code is no longer serving).
--
-- Each swap reuses the pre-built CONCURRENT index via `ADD PRIMARY KEY USING
-- INDEX`, so there is NO index rebuild — only a brief catalog-level
-- ACCESS EXCLUSIVE lock to attach it. Guarded + idempotent: once target_lang is
-- in a table's PK, that block no-ops (also makes this a safe no-op on fresh DBs
-- that already got the 5-col PK from schema.sql).
--
-- After this file, a cell may hold rows for two lanes (e.g. '' and 'es'); the
-- old 4-col PK would have rejected that, so DO NOT let a project add a second
-- lane until this phase is complete.
--
-- Apply:  set -a; . ./.env; set +a
--         npx tsx scripts/pg.ts db/postgres/rollout/aqu538-99-contract.sql

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'cells'::regclass AND i.indisprimary AND a.attname = 'target_lang'
  ) THEN
    ALTER TABLE cells DROP CONSTRAINT cells_pkey;
    ALTER TABLE cells ADD CONSTRAINT cells_pkey PRIMARY KEY USING INDEX cells_pkey5;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'cell_validators'::regclass AND i.indisprimary AND a.attname = 'target_lang'
  ) THEN
    ALTER TABLE cell_validators DROP CONSTRAINT cell_validators_pkey;
    ALTER TABLE cell_validators ADD CONSTRAINT cell_validators_pkey PRIMARY KEY USING INDEX cell_validators_pkey5;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'file_section_progress'::regclass AND i.indisprimary AND a.attname = 'target_lang'
  ) THEN
    ALTER TABLE file_section_progress DROP CONSTRAINT file_section_progress_pkey;
    ALTER TABLE file_section_progress ADD CONSTRAINT file_section_progress_pkey PRIMARY KEY USING INDEX file_section_progress_pkey5;
  END IF;
END $$;
