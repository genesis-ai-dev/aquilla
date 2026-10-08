-- Migration 0153: Aquilla Tools prototype tables.
--
-- Apply by hand (same convention as prior migrations here — NOT applied
-- automatically). PROTOTYPE: not yet applied to any shared environment.
--   set -a; . ./.env; set +a
--   npx tsx scripts/pg.ts db/postgres/migrations/0153_project_tools.sql
-- Verify: `\d project_tools`, `\d project_tool_versions`, `\d project_tool_grants`.

-- Aquilla Tools (prototype): agent-built, sandboxed mini-apps per project.
-- `project_tools` is the tool; `project_tool_versions` its immutable version
-- history (source + manifest + sha256 code hash + bridge api_rev);
-- `project_tool_grants` is each user's STANDING permission grant for a tool.
-- Tool writes are ordinary events; the sync-worker stamps
-- events.provenance = {origin:'tool', toolId, version, codeHash, ...} after
-- verifying them against project_tool_versions (see the partial index below,
-- which the activity/revert read uses).
CREATE TABLE IF NOT EXISTS project_tools (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  current_version    INTEGER NOT NULL DEFAULT 1,
  upstream_tool_id   TEXT,
  created_by_user_id BIGINT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS project_tools_project ON project_tools (project_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS project_tool_versions (
  tool_id            TEXT NOT NULL REFERENCES project_tools(id) ON DELETE CASCADE,
  project_id         TEXT NOT NULL,
  version            INTEGER NOT NULL,
  source             TEXT NOT NULL,
  manifest           JSONB NOT NULL,
  code_hash          TEXT NOT NULL,
  api_rev            INTEGER NOT NULL,
  origin             TEXT NOT NULL CHECK (origin IN ('starter', 'builder', 'edit', 'copy')),
  build_meta         JSONB,
  created_by_user_id BIGINT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tool_id, version)
);
CREATE INDEX IF NOT EXISTS project_tool_versions_hash ON project_tool_versions (project_id, tool_id, code_hash);

CREATE TABLE IF NOT EXISTS project_tool_grants (
  tool_id    TEXT NOT NULL REFERENCES project_tools(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  user_id    BIGINT NOT NULL,
  scopes     JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tool_id, user_id)
);

CREATE INDEX IF NOT EXISTS events_tool_provenance
  ON events (project_id, (provenance->>'toolId'), server_seq)
  WHERE provenance->>'origin' = 'tool';
