-- Migration 0036: projection-rebuild watermark marker (audit 2026-06-10 B5).
--
-- A projection rebuild (sync-worker/src/events/rebuild.ts) replays existing
-- events and mints none, so MAX(events.server_seq) — the GET /cells delta +
-- ETag watermark — does not move even though cells rows changed. Every warm
-- client's `?since=` then returns an empty delta (and If-None-Match 304s)
-- forever, pinning pre-rebuild values in the client's persistent IDB cache.
--
-- rebuilt_seq records the seq the rebuild allocated through the per-project
-- counter when it finished: any `?since=` cursor below it gets the existing
-- `{resync:true}` response, and the value is folded into the ETag so
-- conditional reads miss after a rebuild (cells-read-route.ts). 0 = never
-- rebuilt (or pre-migration), which preserves today's behavior exactly.
--
-- Idempotent — safe to re-apply.

ALTER TABLE project_seq_counters
  ADD COLUMN IF NOT EXISTS rebuilt_seq BIGINT NOT NULL DEFAULT 0;
