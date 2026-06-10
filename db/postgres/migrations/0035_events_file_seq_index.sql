-- Migration 0035: composite index for the per-file server_seq watermark
-- (audit 2026-06-10 M2-1 delta reads).
--
-- GET /cells now computes MAX(server_seq) per (project_id, file_id) on every
-- request (ETag watermark) and range-scans server_seq > ?since for deltas
-- (sync-worker/src/events/cells-read-route.ts). Without this index those
-- queries piggyback on idx_events_cell's (project_id, file_id) prefix with
-- heap fetches; with it both are pure index scans.

CREATE INDEX IF NOT EXISTS idx_events_file_seq
  ON events(project_id, file_id, server_seq);
