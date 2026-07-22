-- Migration 0067: project-brief base_version + history (AQU-AGENT adversarial
-- panel mem-M2/M3, FIX-A).
--
-- WHY: a brief proposal drafted against version N must not silently clobber a
-- human edit that lands as version N+1 between propose and approve. We stamp the
-- brief version a proposal was drafted against (`base_version`) and refuse to
-- apply it if the brief has moved on (route → 409 conflict). Every brief write
-- also snapshots the PRIOR content into `project_brief_history` so a superseded
-- brief is recoverable.

-- Prior-content snapshots, one row per (project, version). `version` is the
-- version being REPLACED (i.e. the content BEFORE the write that created the
-- history row).
CREATE TABLE IF NOT EXISTS project_brief_history (
  project_id text NOT NULL,
  version integer NOT NULL,
  content text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, version)
);

-- The brief version a proposal was drafted against. NULL for legacy proposals
-- created before this column existed (treated as stale-if-brief-advanced at
-- approve time — see reviewBriefProposal).
ALTER TABLE project_brief_proposals
  ADD COLUMN IF NOT EXISTS base_version integer;
