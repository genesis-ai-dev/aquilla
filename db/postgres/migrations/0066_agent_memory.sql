-- Migration 0066: agent memory + project brief (AQU-AGENT contracts §3, owner W1C).
--
-- Three tables backing the agent's long-term, human-reviewed memory:
--   * agent_memories        — proposed/approved/rejected/archived markdown notes,
--                             keyed by (project_id, path). A partial UNIQUE index
--                             enforces "one approved row per path"; approving a
--                             second row supersedes the old one to 'archived'.
--   * project_briefs         — the single human-authored project brief (verbatim
--                             in the agent's system prompt). One row per project.
--   * project_brief_proposals — agent- or human-authored brief edits awaiting a
--                             project-lead's review.
--
-- Provenance (jsonb) records where an agent proposal came from
-- ({runId?, sessionId?, credentialId?}); human_edited pins a row a human touched
-- so the agent channel can never overwrite it (403 human_edit_protected).

CREATE TABLE IF NOT EXISTS agent_memories (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  path text NOT NULL,
  content text NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','archived')),
  human_edited boolean NOT NULL DEFAULT false,
  rationale text,
  provenance jsonb,             -- {runId?, sessionId?, credentialId?}
  created_by text,              -- username
  reviewed_by text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- At most one approved row per (project, path); supersede archives the loser.
CREATE UNIQUE INDEX IF NOT EXISTS agent_memories_approved_path
  ON agent_memories(project_id, path) WHERE status='approved';
CREATE INDEX IF NOT EXISTS agent_memories_project
  ON agent_memories(project_id, status);

CREATE TABLE IF NOT EXISTS project_briefs (
  project_id text PRIMARY KEY,
  content text NOT NULL DEFAULT '',
  updated_by text,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_brief_proposals (
  id uuid PRIMARY KEY,
  project_id text NOT NULL,
  content text NOT NULL,
  rationale text,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  created_by text,
  reviewed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);
CREATE INDEX IF NOT EXISTS project_brief_proposals_project
  ON project_brief_proposals(project_id, status);
