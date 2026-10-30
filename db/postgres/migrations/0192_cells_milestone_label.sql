-- Migration 0192: cells.milestone_label — AQU-2185 "Start a section here".
--
-- The name a person gave a navigator division of their own, or NULL on every
-- cell nobody has marked. `source.cell.milestone.set` writes it (a label to
-- set, `null` to clear) and nothing else; the division it produces is derived
-- from this column at read time by `deriveMilestoneNavigation`, so there is no
-- second copy to keep in step.
--
-- WHY A COLUMN AND NOT `cells.metadata.aquillaImport`: re-import replaces a
-- cell's import envelope wholesale, so a section stored in there would vanish
-- the next time the file was brought in again — and a hand-set section is the
-- one navigator division that is NOT file provenance. This column is absent
-- from the `source.cell.create` UPSERT's SET list, so it survives a re-import
-- and a linked-project mirror upsert the same way `hidden_at` (0116) does.
--
-- WHY SOURCE-SIDE ONLY: a division is a property of the file every lane shares,
-- not of one translation. One event covers every language, and consumers read
-- the label off the shared source row (`side = 'source'`), never off a target
-- row — a target row created after the marker carries no label of its own.
--
-- NULL means "no hand-set section here", which is what every pre-migration row
-- reads as: the feature arrives with nothing marked anywhere. Forward-only; no
-- backfill.
--
-- Apply by hand against Neon (same convention as prior migrations here —
-- NOT applied automatically):
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0192_cells_milestone_label.sql
-- Verify: `milestone_label` appears on `cells`; the partial index exists.

ALTER TABLE cells ADD COLUMN IF NOT EXISTS milestone_label TEXT;

-- A file has a handful of hand-set sections at most, so only the marked rows
-- are indexed — serves the navigation read without putting a full-table index
-- on the hottest table in the schema (same shape as idx_cells_hidden).
CREATE INDEX IF NOT EXISTS idx_cells_milestone_label
  ON cells(project_id, file_id)
  WHERE milestone_label IS NOT NULL;
