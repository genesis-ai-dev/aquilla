-- seed.sql — canonical preview test cast (AD-11; spec §"Preview identity").
--
-- Applied to every per-PR D1 (`aquilla-pr-<N>`) and to the shared dev DB
-- (`aquilla-dev`) after migrations run. Re-runs on the nightly dev reset.
--
-- Schema target: the current shape in apps/identity/migrations/0001_initial.sql.
-- Phase 1A (separate stream) is reshaping the schema toward AD-2's event-log
-- model; once that lands, this seed file gets revised in lockstep with the
-- migration that introduces the new tables.
--
-- ── Cast ──────────────────────────────────────────────────────────────
--
--   alice@test.local  — owner of the sample project
--   bob@test.local    — contributor (400) on the sample project
--   carol@test.local  — reviewer    (300) on the sample project
--   dave@test.local   — no project access (for negative-permission tests)
--
-- ── Passwords ─────────────────────────────────────────────────────────
--
-- All four accounts use the plaintext `test123`. The hash below is a
-- PLACEHOLDER — preview-only — produced by the same Werkzeug-compatible
-- scrypt routine identity uses (apps/identity/src/utils/password.ts).
-- It is NOT a real working hash; computing one requires the runtime, so
-- CI's "apply seed" step needs to either:
--
--   (a) re-hash `test123` with the live worker and substitute, or
--   (b) replace the placeholder string with a hash committed to a sibling
--       fixture file once the per-env hashing job runs.
--
-- Either path keeps the hash out of source control as a load-bearing
-- secret. The current value will fail verifyPassword(); preview test
-- harnesses that need to log in as these users should call the
-- /password-reset/request flow (or its preview-direct-return variant per
-- spec §"Email sending — disabled in preview") rather than POST /login.
--
-- Deliberately kept as a single, easy-to-find constant so the
-- "regenerate seed hashes" CI step has one string to replace.

-- ── Identity ──────────────────────────────────────────────────────────

INSERT INTO users (id, username, email, password_hash, preferences) VALUES
  (1, 'alice', 'alice@test.local', 'scrypt:32768:8:1$PLACEHOLDER_REPLACE_AT_SEED_TIME$00', '{}'),
  (2, 'bob',   'bob@test.local',   'scrypt:32768:8:1$PLACEHOLDER_REPLACE_AT_SEED_TIME$00', '{}'),
  (3, 'carol', 'carol@test.local', 'scrypt:32768:8:1$PLACEHOLDER_REPLACE_AT_SEED_TIME$00', '{}'),
  (4, 'dave',  'dave@test.local',  'scrypt:32768:8:1$PLACEHOLDER_REPLACE_AT_SEED_TIME$00', '{}');

-- ── Sample org (all four cast members) ────────────────────────────────

INSERT INTO organizations (id, name, owner_user_id) VALUES
  (1, 'Aquilla Preview Org', 1);

-- Role levels follow AD-6's ladder: viewer (100) → commenter (200) →
-- reviewer (300) → contributor (400) → project_lead (500) →
-- maintainer (600) → owner (700).
INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
  (1, 1, 700, 1),  -- alice — owner
  (1, 2, 400, 1),  -- bob   — contributor
  (1, 3, 300, 1),  -- carol — reviewer
  (1, 4, 100, 1);  -- dave  — viewer (org member, no project access)

-- ── Sample project + members ──────────────────────────────────────────

INSERT INTO projects (id, name, org_id, created_by) VALUES
  ('proj-preview-sample', 'Preview Sample Project', 1, 1);

-- Project-level overrides win over org grants (AD-6 resolution order).
-- alice doesn't need an explicit row (she's the creator), but we add one
-- to make the test surface explicit.
INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES
  ('proj-preview-sample', 1, 700, 1),  -- alice — owner
  ('proj-preview-sample', 2, 400, 1),  -- bob   — contributor
  ('proj-preview-sample', 3, 300, 1);  -- carol — reviewer
  -- dave is NOT a project member — drives negative-permission tests.

-- ── Sample file + a few cells ─────────────────────────────────────────
--
-- This shape matches what sync-worker projects on Y.Doc onSave. Phase 1A
-- will replace the direct INSERT into `cells` with INSERT INTO `events`
-- once the event-log projection lands; for now we write the projection
-- table directly so the preview UI has something to render before any
-- live editing happens.

INSERT INTO files (id, project_id, name, file_type, source_language, target_language, cell_count, last_edit_at) VALUES
  ('file-preview-sample', 'proj-preview-sample', 'Genesis 1', 'usfm', 'en', 'es', 3, 0);

INSERT INTO cells (file_id, cell_id, content_text, content_hash, validated, word_count, last_editor, last_edit_at, edit_count) VALUES
  ('file-preview-sample', 'GEN 1:1', 'In the beginning God created the heavens and the earth.', 'sha-placeholder-1', 0,  10, 'alice', 0, 1),
  ('file-preview-sample', 'GEN 1:2', 'Now the earth was formless and empty.',                      'sha-placeholder-2', 0,   7, 'alice', 0, 1),
  ('file-preview-sample', 'GEN 1:3', 'And God said, "Let there be light," and there was light.',   'sha-placeholder-3', 0,  11, 'alice', 0, 1);
