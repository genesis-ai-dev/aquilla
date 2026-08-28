-- Migration 0081: drop dead `events` indexes (AQU-1005).
--
-- Every event INSERT maintained 7 indexes on a 28 GB table; production
-- pg_stat_user_indexes (window 2026-08-09 → 2026-08-26) shows two of them do
-- essentially no read work:
--
--   idx_events_cell   (project_id, file_id, cell_id, server_ts) — 4 GB, 0 scans.
--     Equality lookups on (project, file, cell) are served by
--     idx_events_parent_lookup, which shares the same three-column prefix.
--
--   idx_events_author (author, server_ts) — 937 MB, 304 scans.
--     The only author-filtered query (member-activity read) also filters on
--     project_id and orders by server_seq, so idx_events_project_seq covers it
--     at per-project sizes (~200k events max).
--
-- Dead-index maintenance lengthens exactly the transactions that hold the
-- per-project seq-counter row lock — the AQU-1005 write convoy. Dropping them
-- removes ~5 GB of write amplification from the hottest insert path.
DROP INDEX IF EXISTS idx_events_cell;
DROP INDEX IF EXISTS idx_events_author;
