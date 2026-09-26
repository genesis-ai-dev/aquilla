-- Migration 0112: cells.hidden_at — AQU-1422 "Hide cell / Show cell".
--
-- A reversible per-cell park flag. `source.cell.visibility.set` stamps it with
-- the event's serverTs on hide and clears it to NULL on show; nothing is ever
-- deleted, so the source text, every lane's translation, recordings, comments
-- and validations survive a hide/show round trip untouched.
--
-- WHY A COLUMN AND NOT `cells.metadata`: the `source.cell.create` UPSERT
-- overwrites the metadata bucket wholesale, so a re-import or a linked-project
-- mirror upsert would silently un-hide every parked cell. `hidden_at` is absent
-- from that UPSERT's SET list, so it survives both. It also gives reads,
-- exports (AQU-1423), progress/health/search (AQU-1424) and the Agent API
-- (AQU-1426) ONE predicate to filter on — `hidden_at IS NULL`.
--
-- WHY SOURCE-SIDE ONLY: hiding is per cell, not per lane (it parks the row for
-- every language at once), so the flag lives on the shared source row
-- (`side = 'source' AND target_lang = ''`) and consumers resolve a cell's
-- visibility from there. Storing it per row would strand a target row created
-- AFTER the hide — a collaborator's in-flight translation — with the flag
-- unset, which is exactly the row that must not reappear.
--
-- NULL means visible, which is what every pre-migration row reads as: the
-- feature arrives with nothing hidden anywhere. Forward-only; no backfill.
--
-- Apply by hand against Neon (same convention as prior migrations here —
-- NOT applied automatically):
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0112_cells_hidden_at.sql
-- Verify: `hidden_at` appears on `cells`; the partial index exists.

ALTER TABLE cells ADD COLUMN IF NOT EXISTS hidden_at BIGINT;

-- Partial index: hidden cells are a handful per file, so only they are indexed.
-- Serves the "N hidden" counter and the hidden-cell filters in the later
-- slices without adding a full-table index to the hottest table in the schema.
CREATE INDEX IF NOT EXISTS idx_cells_hidden
  ON cells(project_id, file_id)
  WHERE hidden_at IS NOT NULL;
