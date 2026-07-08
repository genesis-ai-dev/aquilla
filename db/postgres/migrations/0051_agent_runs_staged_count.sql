-- Acceptance-rate signal (design §7 kill/health metrics: "≥40% of staged
-- writes applied"). staged_count = target.cell.commit events STAGED across
-- the run's proposals (draft + propose tools). The applied/undone sides come
-- from the event log itself (payload.agent_run_id / undo_of_agent_run_id),
-- so acceptance per run = applied ÷ staged with no extra write path.

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS staged_count INTEGER NOT NULL DEFAULT 0;
