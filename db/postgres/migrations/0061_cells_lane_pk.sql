-- 0061_cells_lane_pk.sql
--
-- AQU-538 CONTRACT half for `cells` (pairs with the EXPAND migration 0057).
-- Promotes the primary key to the 5-column lane form by attaching the
-- unique index `cells_pkey5` that 0057 already built — no index rebuild, only a
-- brief catalog-level ACCESS EXCLUSIVE lock.
--
-- RUN ONLY AFTER the lane-aware workers are deployed and the old version has
-- drained. Until this runs, the old 4-column PK is still in force, so the
-- deployed code's `ON CONFLICT(project_id,file_id,cell_id,side)` keeps working;
-- once it runs, a cell may hold rows for two lanes (which the old 4-col PK would
-- have rejected) — so no project may add a second target language before this.
--
-- Guarded + idempotent: once target_lang is in the PK, the block no-ops (also a
-- clean no-op on fresh DBs that got the 5-col PK from schema.sql — there
-- cells_pkey5 does not exist and the guard skips it).
--
-- NOT applied automatically to live Neon branches. Apply by hand:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0061_cells_lane_pk.sql
-- Verify: the `cells` primary key definition lists target_lang.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'cells'::regclass
      AND i.indisprimary
      AND a.attname = 'target_lang'
  ) THEN
    ALTER TABLE cells DROP CONSTRAINT cells_pkey;
    ALTER TABLE cells ADD CONSTRAINT cells_pkey PRIMARY KEY USING INDEX cells_pkey5;
  END IF;
END $$;
