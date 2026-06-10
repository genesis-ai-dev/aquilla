-- Migration 0034: per-project server_seq allocator + AD-2 chain claims
-- (audit 2026-06-10 RACE-1 / RACE-2 / PERF-5 → tasks M1-1 / M1-2).
--
-- project_seq_counters: one row per project, bumped inside the SAME
-- transaction as every events INSERT (sync-worker/src/events/event-insert.ts).
-- The row lock serializes concurrent same-project writers so two transactions
-- can never compute the same server_seq — previously both derived
-- MAX(server_seq)+1 under READ COMMITTED and the loser's unique-index
-- collision was swallowed by an unqualified ON CONFLICT DO NOTHING, silently
-- dropping the event-log row while its cells projection still committed.
-- Seeded lazily from MAX(events.server_seq) on a project's first post-deploy
-- write; self-heals via GREATEST if the counter ever falls behind the log.
--
-- chain_claims: one row per AD-2 chain slot (project, file, cell, parent);
-- the first transaction to commit a claim owns the slot, atomically —
-- replacing the check-then-act isWinningChild SELECT for in-flight races.
-- parent_key = parent_id, with '<null>' standing in for genesis events.
-- No backfill needed: historical slots are still arbitrated by the
-- isWinningChild pre-check against `events`; claims only arbitrate slots
-- contested after this deploy.
--
-- Idempotent — safe to re-apply.

CREATE TABLE IF NOT EXISTS project_seq_counters (
    project_id TEXT PRIMARY KEY,
    last_seq   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_claims (
    project_id TEXT NOT NULL,
    file_id    TEXT NOT NULL,
    cell_id    TEXT NOT NULL,
    parent_key TEXT NOT NULL,
    event_id   TEXT NOT NULL,
    PRIMARY KEY (project_id, file_id, cell_id, parent_key)
);
