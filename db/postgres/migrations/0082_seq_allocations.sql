-- AQU-1005: seq-allocation ledger.
--
-- Seq allocation is moving OUT of the event-write transaction (which held the
-- project_seq_counters row lock for the whole batch — the lock convoy) into a
-- tiny autocommit statement that bumps the counter AND announces the range
-- here. The write batch deletes its row atomically with the event rows; a
-- crashed/aborted writer's row expires (readers ignore rows older than the
-- TTL; the next allocator for the project deletes them).
--
-- Readers use MIN(first_seq)-1 over live rows as the "pending floor": the
-- highest server_seq that is safe to advertise as a ?since= cursor. Rows
-- above the floor are still delivered — only the cursor is clamped — so a
-- late-committing writer's events are re-covered by the next delta instead
-- of being skipped.
CREATE TABLE IF NOT EXISTS seq_allocations (
    project_id TEXT NOT NULL,
    first_seq  BIGINT NOT NULL,
    last_seq   BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, first_seq)
);
