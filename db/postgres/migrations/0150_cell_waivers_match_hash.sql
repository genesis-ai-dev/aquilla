-- 0150_cell_waivers_match_hash.sql — AQU-1740
--
-- A waiver was keyed (project_id, file_id, cell_id, rule_id), so accepting one
-- repeated word hid every repeated-word finding in that cell — including ones
-- the translator introduced afterwards. Paratext's Biblical Terms "deny" is
-- per occurrence; this column is what makes the same granularity possible here.
--
-- `match_hash` is a hash of the finding's matched text (cyrb53 over an
-- NFC/whitespace/case-normalized form — src/lib/rules/match-hash.ts), NOT the
-- span offsets, which move whenever anything earlier in the cell is edited.
--
-- `''` means "no finding named" — the rule is waived across the whole cell.
-- That is exactly what every row stored before this migration meant, so NOT
-- NULL DEFAULT '' backfills them to the right semantics with no data pass, and
-- a client that has not been updated keeps emitting that same shape.
--
-- The primary key has to be replaced rather than extended: the existing one
-- would still collapse two findings of one rule onto a single row.

ALTER TABLE cell_waivers
  ADD COLUMN IF NOT EXISTS match_hash TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cell_waivers_pkey'
       AND conrelid = 'public.cell_waivers'::regclass
  ) THEN
    ALTER TABLE public.cell_waivers DROP CONSTRAINT cell_waivers_pkey;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cell_waivers_pkey'
       AND conrelid = 'public.cell_waivers'::regclass
  ) THEN
    ALTER TABLE public.cell_waivers
      ADD CONSTRAINT cell_waivers_pkey
      PRIMARY KEY (project_id, file_id, cell_id, rule_id, match_hash);
  END IF;
END $$;
