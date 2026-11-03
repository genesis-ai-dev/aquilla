-- 0192: let ONE language lane own a knowledge document or a style rule
-- (AQU-2348).
--
-- A project's Living Memory is the default for every target lane. The prose
-- sections a lane may override live in `project_settings`
-- (`systemPromptByLane`, `translationBriefByLane`), so they needed no schema
-- change. Knowledge documents and style rules are ROWS, and a lane does not
-- override a row — it adds one: a row with `lane_id IS NULL` is the project's
-- and is in force in every lane, a row with a `lane_id` is that lane's and is
-- in force only there (db/shared/lane-memory.ts → `laneRowFilterSql`, the one
-- rule every retrieval query and the client's in-memory filter share).
--
-- Nullable and with no default, so EVERY existing row is project-wide and
-- every retrieval answers exactly what it answered before this column
-- existed. Nothing to backfill, nothing to migrate in the app, and a legacy
-- project whose default lane carries only the `''` tag opens unchanged.
--
-- `lane_id` is the lane's opaque 8-hex `lanes.id` (AQU-1240), never a language
-- or a legacy tag: a rename must not strand a lane's own documents. It is NOT
-- a foreign key to `lanes(id)` — `lanes.id` is unique per project, not
-- globally, so the reference is (project_id, lane_id) and the FK would have to
-- be composite against a key `lanes` does not declare. The CHECK below carries
-- the invariant that matters: only a project-scoped row may name a lane, since
-- lane ids are project-local and an org-shared row keyed by one project's lane
-- would name a lane the next project does not have.
--
-- Deliberately NOT done here: a `lane` `target_type` on `rule_applicability`.
-- Applicability answers *where in the text* a rule bites; a lane answers *for
-- whom* it was written. Mixing them would make the compiler's `excluded`
-- relationship ambiguous — "excluded from this lane" and "excluded from this
-- passage" are different claims.
--
-- Additive and backward-compatible in both directions: code that does not know
-- the column still reads and writes every row, and this release's readers treat
-- NULL as project-wide.

ALTER TABLE knowledge_docs ADD COLUMN IF NOT EXISTS lane_id TEXT;
ALTER TABLE style_rules ADD COLUMN IF NOT EXISTS lane_id TEXT;

-- Only a project's own row may belong to a lane (org-shared rows never do).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_docs_lane_is_project_scoped'
  ) THEN
    ALTER TABLE knowledge_docs
      ADD CONSTRAINT knowledge_docs_lane_is_project_scoped
      CHECK (lane_id IS NULL OR project_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'style_rules_lane_is_project_scoped'
  ) THEN
    ALTER TABLE style_rules
      ADD CONSTRAINT style_rules_lane_is_project_scoped
      CHECK (lane_id IS NULL OR project_id IS NOT NULL);
  END IF;
END $$;

-- Retrieval reads "the project's rows plus this lane's", so the lane-owned
-- rows are the selective side; index only those (every other row is NULL).
CREATE INDEX IF NOT EXISTS knowledge_docs_project_lane
  ON knowledge_docs (project_id, lane_id) WHERE lane_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS style_rules_project_lane
  ON style_rules (project_id, lane_id, status) WHERE lane_id IS NOT NULL;
