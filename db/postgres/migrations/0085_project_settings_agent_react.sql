-- Migration 0085: `agentMode.react` projection on project_settings
-- (docs/superpowers/specs/2026-08-28-agent-social-workspace-design.md §v3,
-- "React loop": for each project with `react` on, read the append-only events
-- table past a per-project cursor…).
--
-- The react watcher rides the 5-minute cron, so every sweep has to answer
-- "which projects have react on?" across the WHOLE table. `settings` is TEXT
-- holding blobs that run to multiple MB (see the column comments on
-- project_settings and the org-dashboard timeout that motivated 0054/0575), so
-- an inline `(settings::jsonb)->'agentMode'->>'react'` filter would parse every
-- project's blob every five minutes. Same fix as the language pair and the
-- validation count: project the one scalar at write time and index it.
--
-- Deliberately BOOLEAN rather than TEXT: a JSON `true` is the only value the
-- watcher acts on, and `= 'true'` collapses `false`, absent, null, and any
-- hand-written garbage to the same "off" answer — which is the documented
-- default (all switches off) for a project that has never set agentMode.

ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS agent_react BOOLEAN
    GENERATED ALWAYS AS (((settings::jsonb) -> 'agentMode' ->> 'react') = 'true') STORED;

-- Partial: the sweep only ever asks for the `true` rows, and on a healthy
-- deployment that is a small minority of projects.
CREATE INDEX IF NOT EXISTS project_settings_agent_react
  ON project_settings(project_id)
  WHERE agent_react;
