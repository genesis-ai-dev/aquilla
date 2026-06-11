-- Migration 0039: drop named project snapshots (FRO-176 removed).
--
-- Backward-compatible: the sync-worker no longer exposes snapshot routes;
-- existing rows are discarded. Safe to apply before client deploy.

DROP POLICY IF EXISTS rls_snapshots_project_access ON snapshots;
DROP TABLE IF EXISTS snapshots;
