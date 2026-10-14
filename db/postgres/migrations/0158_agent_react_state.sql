-- 0158_agent_react_state.sql — AQU-1846
--
-- The react watcher's per-project bookmark moves OUT of the project_settings
-- blob and into its own table, and gains the round-robin stamp the cron needs.
--
-- Two defects motivate this, both in lib/react-loop.ts:
--
--   1. The candidate query was `ORDER BY ps.project_id ASC LIMIT 10`, so once
--      more than ten projects had react on, the eleventh by id was never swept
--      — it simply did not react, forever. Ordering by a last-swept stamp
--      (nulls, i.e. never swept, first) makes the sweep a round robin: every
--      react-enabled project is visited within ceil(N / 10) cycles.
--   2. Persisting the cursor meant a read-modify-write of `settings`, which is
--      TEXT holding blobs that run to multiple MB (see the column comments on
--      project_settings), every five minutes per swept project — and a version
--      guard that could lose the race against a human settings edit.
--
-- `cursor_ms` is epoch millis, matching `events.server_ts`: every event at or
-- below it has been CONSIDERED. NULL means never swept, which the watcher
-- seeds from a bounded lookback rather than the project's whole history.
-- `last_reaction_at` is fileId → ISO timestamp, the per-file cooldown input;
-- the watcher prunes expired entries on write so it cannot grow without bound.
--
-- The old `agentReactState` key is left in the blob rather than stripped:
-- rewriting every blob is precisely the write this migration removes. It is
-- inert after this — nothing reads it — and backfilled below so no project
-- loses its cursor and re-reacts to a window it already considered.
--
-- Idempotent. A database loaded from schema.sql already has the table.

CREATE TABLE IF NOT EXISTS agent_react_state (
    project_id       TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    cursor_ms        BIGINT,
    last_reaction_at JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- When the cron last VISITED this project (not when it last reacted), so
    -- the candidate query can order by it. NULL = never visited, swept first.
    last_swept_at    TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The sweep's ordering key. The candidate set is already narrowed by the
-- partial project_settings_agent_react index (0123), so this only has to keep
-- the ordered read off a sort of the whole table as react adoption grows.
CREATE INDEX IF NOT EXISTS agent_react_state_last_swept
  ON agent_react_state(last_swept_at ASC NULLS FIRST, project_id ASC);

-- Backfill from the blob. Guarded casts: a cursor that is not a positive
-- integer, and a lastReactionAt that is not an object, read as absent — the
-- same tolerance the old blob reader had (readAgentReactState in agent-mode.ts
-- treated garbage as unset rather than throwing). `last_swept_at` stays NULL
-- so every already-enabled project is in the first round of the new rotation.
INSERT INTO agent_react_state (project_id, cursor_ms, last_reaction_at)
SELECT ps.project_id,
       CASE
         WHEN (ps.settings::jsonb -> 'agentReactState' ->> 'cursor') ~ '^[0-9]+$'
           AND (ps.settings::jsonb -> 'agentReactState' ->> 'cursor')::NUMERIC > 0
         THEN (ps.settings::jsonb -> 'agentReactState' ->> 'cursor')::BIGINT
       END,
       CASE
         WHEN jsonb_typeof(ps.settings::jsonb -> 'agentReactState' -> 'lastReactionAt') = 'object'
         THEN ps.settings::jsonb -> 'agentReactState' -> 'lastReactionAt'
         ELSE '{}'::jsonb
       END
  FROM project_settings ps
  JOIN projects p ON p.id = ps.project_id
 WHERE jsonb_typeof(ps.settings::jsonb -> 'agentReactState') = 'object'
ON CONFLICT (project_id) DO NOTHING;
