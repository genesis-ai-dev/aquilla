-- 0076: contextual decisions — the agent → user channel (seam design §4.3).
--
-- A decision is a question autopilot cannot answer alone. It closes exactly
-- two ways (a human answers, or the agent researches it into a memory
-- proposal); routing only ASSIGNS it and leaves it open. Two further terminal
-- states are bookkeeping, and are deliberately distinct: `superseded` means the
-- underlying gap got filled by other means (healthy), `expired` means nobody
-- ever answered (unhealthy). Merging them would let the healthy case hide the
-- warning the unhealthy one exists to give.
--
-- NOT applied automatically to live Neon branches. Apply by hand:
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0076_contextual_decisions.sql

CREATE TABLE IF NOT EXISTS contextual_decisions (
  id text PRIMARY KEY,                  -- uuidv7
  project_id text NOT NULL,
  run_id text,                          -- NULL once the owning run ends
  file_id text NOT NULL,
  span_id text,
  cell_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- WHY the agent cannot proceed, in the user's words. Never "review this".
  reason text NOT NULL,
  -- Which readiness item this gap belongs to; NULL for free-text ambiguities,
  -- which the deterministic sweep can never close.
  readiness_item text
    CHECK (readiness_item IS NULL OR
           readiness_item IN ('terminology','brief','examples','rules','languages')),
  -- Set only for terminology decisions: the concept whose rendering is missing.
  concept_id text,
  -- How many later passages the answer affects. Drives surfacing rank (§4.6)
  -- and belongs in the reason text too, because it is what makes a card
  -- answerable.
  blast_radius integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','researching','resolved','dismissed','superseded','expired')),
  -- Routing is an ASSIGNMENT, not a resolution: an assigned decision is still
  -- `open`, and anyone who joins later can answer it.
  assigned_user_id integer,
  assigned_invite_id text,
  resolution jsonb,                     -- {kind:'answered'|'researched', …}
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- Surfacing reads the open set per project, ranked by blast radius then age.
CREATE INDEX IF NOT EXISTS contextual_decisions_open
  ON contextual_decisions(project_id, blast_radius DESC, created_at ASC)
  WHERE status IN ('open','researching');

-- The supersession sweep and the run-unblock path both look up by run.
CREATE INDEX IF NOT EXISTS contextual_decisions_run
  ON contextual_decisions(run_id)
  WHERE status IN ('open','researching');

-- `waiting` = something left to do, but it needs a human. Distinct from
-- `parked` (nothing left to do). A waiting run is ACTIVE, so it participates
-- in the one-active-run-per-lane unique index below.
ALTER TABLE contextual_runs DROP CONSTRAINT IF EXISTS contextual_runs_status_check;
ALTER TABLE contextual_runs ADD CONSTRAINT contextual_runs_status_check
  CHECK (status IN ('running','pausing','paused','parked','waiting','done','failed','terminated'));

ALTER TABLE contextual_runs
  ADD COLUMN IF NOT EXISTS blocked_on_decision_id text;

DROP INDEX IF EXISTS contextual_runs_active;
CREATE UNIQUE INDEX IF NOT EXISTS contextual_runs_active
  ON contextual_runs(project_id, file_id, target_lang)
  WHERE status IN ('running','pausing','paused','parked','waiting');
