-- Migration 0070: scene briefs (contextual translation pipeline design §9).
--
-- One row per analyzed scene span: a construal (L2 markdown) + ambiguity
-- register + optional condensed L1 summary, keyed by endpoint cell UUIDs
-- (never ordinals — membership = walk document order between them). Modeled
-- on agent_memories: proposed → approved → archived (superseded) / rejected,
-- with a partial UNIQUE index keeping exactly one approved brief per
-- (project, file, span, target_lang). `human_edited` pins a row a human
-- touched so the agent channel can never overwrite it. `stale_since` /
-- `stale_reason` are the instant staleness marker (re-work is debounced
-- elsewhere); NULL stale_since = fresh.

CREATE TABLE IF NOT EXISTS scene_briefs (
  id text PRIMARY KEY,              -- uuidv7
  project_id text NOT NULL,
  file_id text NOT NULL,
  start_cell_id text NOT NULL,      -- endpoint UUIDs, never ordinals
  end_cell_id text NOT NULL,
  target_lang text NOT NULL DEFAULT '',
  construal text NOT NULL,          -- L2: situation/participants/tenor/moves markdown
  ambiguity_register jsonb NOT NULL DEFAULT '[]',
  l1_summary text,                  -- ≤1600 chars, injected into draft prompts
  l1_generated_at timestamptz,
  l1_model_id text,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','archived')),
  human_edited boolean NOT NULL DEFAULT false,
  stale_since timestamptz,          -- instant marker; NULL = fresh
  stale_reason text,                -- 'source-edit' | 'neighbor-change' | 'endpoint-tombstoned' | ...
  provenance jsonb,                 -- {runId?, spanSeedSource?, closureRounds?, windowCellIds?}
  created_by text,                  -- username
  reviewed_by text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- At most one approved brief per (project, file, span, target_lang); supersede
-- archives the loser.
CREATE UNIQUE INDEX IF NOT EXISTS scene_briefs_live
  ON scene_briefs(project_id, file_id, start_cell_id, end_cell_id, target_lang)
  WHERE status='approved';
CREATE INDEX IF NOT EXISTS scene_briefs_lookup
  ON scene_briefs(project_id, file_id, start_cell_id);
