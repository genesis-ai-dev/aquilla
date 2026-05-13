-- Smoke test for pr-db-fork.yml + per-PR D1 provisioning.
-- This migration is intentionally trivial; the PR is opened only to verify
-- that the CLOUDFLARE_API_TOKEN now has the D1 scopes the workflow needs.
-- Delete this file (and the test PR) once the smoke passes.

CREATE TABLE IF NOT EXISTS _smoke_test_marker (
  id INTEGER PRIMARY KEY,
  note TEXT NOT NULL DEFAULT 'pr-db-fork smoke'
);
