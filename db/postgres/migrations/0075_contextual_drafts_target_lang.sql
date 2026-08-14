-- 0075: give Autopilot drafts their own target-language lane identity.
--
-- Runs and scene briefs already carry `target_lang`. Drafts did not, so the
-- live unique index was one proposed row per (project, file, cell) globally.
-- A French proposal and a Spanish proposal for the same cell could not coexist,
-- and the review queue could not tell them apart. Tick/start therefore rejected
-- every non-default lane rather than write evidence the editor could mis-apply.
--
-- Adding `target_lang DEFAULT ''` is backward-compatible for current clients:
-- they only insert/list the default lane, and omitted columns still land as
-- `''`. Backfill copies lane identity from the owning run so any historic
-- non-default prototype rows become filterable.
--
-- There are no live non-default drafts in production (the tick guard failed
-- those runs before staging), so this migration drops the three-column unique
-- and replaces it with the four-column one in the same step. Old SPAs that
-- omit targetLang still read/write the default lane; new workers must ship
-- with the four-column ON CONFLICT target.
--
-- NOT applied automatically to live Neon branches. Apply by hand:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0075_contextual_drafts_target_lang.sql

ALTER TABLE contextual_drafts
  ADD COLUMN IF NOT EXISTS target_lang text NOT NULL DEFAULT '';

-- Historic rows inherit the owning run's lane. Runs never change target_lang
-- after insert, so this is a one-time copy, not an ongoing join.
UPDATE contextual_drafts AS draft
   SET target_lang = owner.target_lang
  FROM contextual_runs AS owner
 WHERE owner.id = draft.run_id
   AND owner.project_id = draft.project_id
   AND owner.file_id = draft.file_id
   AND draft.target_lang IS DISTINCT FROM owner.target_lang;

DROP INDEX IF EXISTS contextual_drafts_live;

CREATE UNIQUE INDEX IF NOT EXISTS contextual_drafts_live
  ON contextual_drafts(project_id, file_id, cell_id, target_lang)
  WHERE status = 'proposed';
