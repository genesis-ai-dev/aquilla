-- 0130: smart edits — the project's edit memory.
--
-- Every settled human edit of a target cell (after an AI draft OR after another
-- person's text) is diffed into phrase-level operations — "the Lord" → "Yahweh",
-- with two words of context either side and the cell's source tokens — and one
-- row per operation lands here. Suggestions are computed from these rows at
-- read time (auth-worker routes/ai-smart-edits.ts); nothing aggregated is
-- stored, so there is no counter to drift from the rows it counts.
--
-- Derived data: every row can be rebuilt from `events`. Deleting a project's
-- rows and its `smart_edit_state` row makes the next request rebuild them.
--
--   smart_edit_observations  one row per edit op (id = '<after event id>:<op>')
--   smart_edit_state         per-project watermark of events already mined
--   smart_edit_feedback      accept / dismiss on a shown suggestion — dismissals
--                            are counter-evidence for that (old → new) edit
--
-- Foreign keys are intentionally omitted, matching db/postgres/schema.sql.
--
-- NOT applied automatically to live Neon branches. Apply by hand:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0130_smart_edits.sql

CREATE TABLE IF NOT EXISTS smart_edit_observations (
  project_id text NOT NULL,
  id text NOT NULL,
  lane text NOT NULL,                  -- payload targetLang ('' = default lane)
  file_id text NOT NULL,
  cell_id text NOT NULL,
  after_event_id text NOT NULL,
  before_event_id text NOT NULL,
  author text NOT NULL,
  ts bigint NOT NULL,                  -- after event server_ts
  before_origin text NOT NULL CHECK (before_origin IN ('human', 'ai', 'machine')),
  bulk_key text,                       -- replace-all: counted once, not per cell
  old text NOT NULL,
  old_norm text NOT NULL,
  new text NOT NULL,
  new_norm text NOT NULL,
  left_ctx text NOT NULL,              -- JSON array of normalized tokens
  right_ctx text NOT NULL,             -- JSON array of normalized tokens
  source_norms text NOT NULL,          -- JSON array of normalized source tokens
  source_text text NOT NULL,
  before_text text NOT NULL,
  after_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS smart_edit_observations_old
  ON smart_edit_observations(project_id, lane, old_norm);

CREATE TABLE IF NOT EXISTS smart_edit_state (
  project_id text PRIMARY KEY,
  -- Events with server_ts <= this have been mined. Always <= now - the settle
  -- window, so a commit still being typed is never mined half-finished.
  mined_through bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS smart_edit_feedback (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  lane text NOT NULL,
  user_id text NOT NULL,
  file_id text NOT NULL,
  cell_id text NOT NULL,
  old_norm text NOT NULL,
  new_norm text NOT NULL,
  action text NOT NULL CHECK (action IN ('accept', 'dismiss')),
  tier text NOT NULL CHECK (tier IN ('memory', 'jev', 'llm')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS smart_edit_feedback_old
  ON smart_edit_feedback(project_id, lane, old_norm);

ALTER TABLE smart_edit_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE smart_edit_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_smart_edit_observations ON smart_edit_observations;
CREATE POLICY rls_smart_edit_observations ON smart_edit_observations
  AS PERMISSIVE FOR ALL TO app_runtime
  USING (NULLIF(current_setting('app.project_id', true), '') IS NULL
         OR project_id = current_setting('app.project_id', true))
  WITH CHECK (NULLIF(current_setting('app.project_id', true), '') IS NULL
              OR project_id = current_setting('app.project_id', true));

ALTER TABLE smart_edit_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE smart_edit_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_smart_edit_state ON smart_edit_state;
CREATE POLICY rls_smart_edit_state ON smart_edit_state
  AS PERMISSIVE FOR ALL TO app_runtime
  USING (NULLIF(current_setting('app.project_id', true), '') IS NULL
         OR project_id = current_setting('app.project_id', true))
  WITH CHECK (NULLIF(current_setting('app.project_id', true), '') IS NULL
              OR project_id = current_setting('app.project_id', true));

ALTER TABLE smart_edit_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE smart_edit_feedback FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_smart_edit_feedback ON smart_edit_feedback;
CREATE POLICY rls_smart_edit_feedback ON smart_edit_feedback
  AS PERMISSIVE FOR ALL TO app_runtime
  USING (NULLIF(current_setting('app.project_id', true), '') IS NULL
         OR project_id = current_setting('app.project_id', true))
  WITH CHECK (NULLIF(current_setting('app.project_id', true), '') IS NULL
              OR project_id = current_setting('app.project_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE smart_edit_observations TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE smart_edit_state TO app_runtime;
GRANT SELECT, INSERT ON TABLE smart_edit_feedback TO app_runtime;
