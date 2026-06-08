-- Migration: 0030_termbase_subscriptions.sql
-- Description: Org-level termbase publish/subscribe (terminology Slices 6-7;
--   aquilla-specs 04-features/terminology.md §"Termbase — sharing across
--   projects"). ADDITIVE ONLY — adds one nullable-default flag to `projects`
--   and one new join table. Nothing existing is dropped or altered
--   destructively.
--
-- Model:
--   * A project may *publish* its termbase to its org, making it discoverable
--     by other projects in the same org (`projects.org_published_termbase`).
--   * A project may *subscribe* to one or more published termbases, with an
--     ordered priority for resolution (lower priority number = higher
--     precedence). Each subscription is one row in
--     `project_termbase_subscriptions`.
--
-- Implicit grant (Q19-style): subscribing confers an implicit *viewer* read on
-- the upstream termbase project, scoped to termbase data only — mirrors the
-- source-project link pattern (canReadSourceCells in
-- services/project-permissions.ts). The read is derived from the subscription
-- row at resolve time; no project_members write is performed. See the route
-- module + docs/swarm/TERM3-ORG-API.md SWARM-TODO for the resolver wiring.
--
-- SWARM-TODO(orchestrator): this migration has NOT been applied to live Neon.
-- The canonical Postgres schema (db/postgres/schema.sql) carries the same
-- additive DDL for the test PGlite; the orchestrator must apply this to live
-- Neon after review (per the documented D1->Neon schema-drift caution).

-- 1. Publish flag on projects (additive; default false). Idempotent.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS org_published_termbase BOOLEAN NOT NULL DEFAULT FALSE;

-- Discoverability index: only published rows matter for the org listing.
CREATE INDEX IF NOT EXISTS idx_projects_org_published_termbase
  ON projects (org_id)
  WHERE org_published_termbase = TRUE;

-- 2. Subscriptions join table. PK (project_id, termbase_project_id) makes a
--    subscription idempotent (re-subscribe = no-op / priority update).
CREATE TABLE IF NOT EXISTS project_termbase_subscriptions (
    project_id          TEXT    NOT NULL,
    termbase_project_id TEXT    NOT NULL,
    priority            INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (project_id, termbase_project_id)
);

-- Lookup by upstream termbase (e.g. "who subscribes to me?" + implicit-grant
-- reverse checks).
CREATE INDEX IF NOT EXISTS idx_termbase_subs_termbase
  ON project_termbase_subscriptions (termbase_project_id);
