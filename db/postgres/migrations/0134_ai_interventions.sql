-- Migration 0134 (AQU-1656): ai_interventions — an audit trail for what the AI
-- did to a cell, and why.
--
-- A committed AI draft already carries `ai_draft` provenance (model, example
-- ids, mode), but not the prompt the model saw or what it answered. Without
-- those, nobody can say why a draft came out the way it did, and later checks
-- (smart edits, the harmonizer) have nothing to be tuned against.
--
-- One row per cell per model call. The full trace (prompt messages + raw
-- model output) is one R2 object per CALL in the SNAPSHOTS bucket at
-- `trace_key`, shared by every cell the call drafted — prompts run 5–30 KB and
-- a batch drafts a chapter at a time, which is too much for Neon.
--
-- `id` is the intervention id the client also writes into the committed
-- draft's provenance (`ai_draft.interventionId`). That link is how a viewer
-- tells a current intervention from one "made on an older version": the cell's
-- current draft either still carries this id or it does not.
--
-- kind     'draft' today; 'smart_edit' and 'harmonize' are reserved for the
--          checks that will record here next.
-- outcome  'applied' (committed as the cell's draft). Suggestion kinds will add
--          'shown' / 'accepted' / 'dismissed' / 'reverted'.
--
-- Foreign keys are intentionally omitted, matching db/postgres/schema.sql.
--
-- NOT applied automatically to live Neon branches. Apply by hand:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0134_ai_interventions.sql

CREATE TABLE IF NOT EXISTS ai_interventions (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  call_id text NOT NULL,                -- one model call; shared by its cells
  lane text NOT NULL DEFAULT '',        -- target lane legacy tag ('' = default)
  file_id text NOT NULL,
  cell_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('draft', 'smart_edit', 'harmonize')),
  mode text NOT NULL,                   -- single | batch | paragraph | …
  outcome text NOT NULL DEFAULT 'applied',
  model text NOT NULL,
  provider text NOT NULL,
  based_on_event_id text,               -- the cell's target head when asked
  output text NOT NULL,                 -- what this cell received (≤ 20k chars)
  example_cell_ids text NOT NULL DEFAULT '[]',  -- JSON array
  scores text,                          -- JSON object, check-specific
  trace_key text,                       -- R2 key of {messages, output}; NULL = not stored
  user_id text NOT NULL,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_interventions_cell_idx
  ON ai_interventions (project_id, cell_id, created_at DESC);
