-- AQU-1278: the structural share of file_section_progress's audio pair.
--
-- 0092 gave every TEXT counter a structural twin so a reader that excludes
-- headings subtracts rather than reprojects. audio_count and
-- audio_validated_count (0088) never got one. So the moment a team opts out of
-- counting headings, a book whose chapter headings were voiced reports MORE
-- audio than it has cells: the denominator loses the headings and the numerator
-- keeps them. The plan board clamps the result to "nothing left" — the right
-- words for the wrong reason, and a 110% bar on the way there.
--
-- Sam, 2026-09-16: "When headings are recorded and the org excludes headings
-- from progress, then exclude recorded headings from the count of recordings.
-- They just don't matter at all. They don't count towards or against anything."
--
-- Same policy-blind design as 0092, for the same reason: the projection records
-- the subset on every row whatever the setting says, and only readers subtract,
-- so the setting stays a toggle rather than a reprojection.
--
-- NO BACKFILL HERE, deliberately. These two numbers are an aggregate over
-- cell_audio joined through the same scope-matching the projection does, and a
-- second hand-written copy of that arithmetic in SQL is exactly how the two
-- drift. The projection itself is the backfill: run it after applying this.
-- Until then every row reads 0, and subtracting 0 is today's behaviour — the
-- same safe degradation direction 0092 relies on.
--
-- NOT applied automatically to live Neon branches (neon:status is a deploy
-- precondition and will fail until this has run). Apply through the migration
-- runner — it records the ledger row the deploy gate reads; a by-hand
-- `scripts/pg.ts` apply leaves the gate red after the migration has run —
-- then backfill only the files whose projection predates these columns:
--   pnpm neon:apply:prod
--   pnpm neon:backfill:progress:prod --missing-books

BEGIN;

ALTER TABLE file_section_progress
  ADD COLUMN IF NOT EXISTS structural_audio_count           INTEGER NOT NULL DEFAULT 0 CHECK (structural_audio_count >= 0),
  ADD COLUMN IF NOT EXISTS structural_audio_validated_count INTEGER NOT NULL DEFAULT 0 CHECK (structural_audio_validated_count >= 0);

COMMIT;
