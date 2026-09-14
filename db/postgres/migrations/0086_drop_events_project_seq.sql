-- Second half of 0085: idx_events_project_seq_id carries the same unique key
-- plus INCLUDE (id), so the original index is now pure write amplification on
-- the hottest insert path (every event INSERT maintains it inside the
-- per-project seq-counter lock window — the AQU-1005 convoy).
--
-- Separate file so it only runs after 0085 committed successfully. Single
-- statement: CONCURRENTLY cannot run in a transaction block.
DROP INDEX CONCURRENTLY IF EXISTS idx_events_project_seq;
