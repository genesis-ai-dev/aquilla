-- seed.sql — canonical preview test cast (AD-11; spec §"Preview identity").
--
-- Applied to every per-PR D1 (`aquilla-pr-<N>`) and to the shared dev DB
-- (`aquilla-dev`) after migrations run. Re-runs on the nightly dev reset.
--
-- Schema target: the current shape after all migrations in
-- apps/identity/migrations/ (through 0012). The AD-2 event-log reshape has
-- landed: `cells` and `files` are projections keyed by `event_id` FKs into
-- `events`, so the cell/file rows below are seeded alongside genesis events.
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

-- ── Sample file + a few cells (AD-2 event-log shape) ──────────────────
--
-- Post-reshape (migrations 0002/0003/0006/0008/0011/0012): `cells.event_id`
-- and `files.event_id` are NOT NULL FKs to `events(id)`, so we seed genesis
-- events FIRST, then the projection rows that reference them. One paired
-- source + target cell per verse (shared cell_id, differing `side`).

-- Genesis events: one file.create + per-cell source/target create events.
INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, parent_id, server_seq) VALUES
  ('seed-ev-file',  1, 'proj-preview-sample', 'file-preview-sample', NULL,      'file.create',        'alice', '{"name":"Genesis 1","role":"target","kind":"codex","bookCode":"GEN","sourceLanguage":"en","targetLanguage":"es"}', 0, 0, NULL, 1),
  ('seed-ev-c1-s',  1, 'proj-preview-sample', 'file-preview-sample', 'GEN 1:1', 'source.cell.create', 'alice', '{"cellId":"GEN 1:1","value":"In the beginning God created the heavens and the earth.","type":"verse","canonicalRef":"GEN 1:1"}', 0, 0, NULL, 2),
  ('seed-ev-c1-t',  1, 'proj-preview-sample', 'file-preview-sample', 'GEN 1:1', 'target.cell.create', 'alice', '{"cellId":"GEN 1:1","value":"En el principio creó Dios los cielos y la tierra."}', 0, 0, NULL, 3),
  ('seed-ev-c2-s',  1, 'proj-preview-sample', 'file-preview-sample', 'GEN 1:2', 'source.cell.create', 'alice', '{"cellId":"GEN 1:2","value":"Now the earth was formless and empty.","type":"verse","canonicalRef":"GEN 1:2"}', 0, 0, NULL, 4),
  ('seed-ev-c2-t',  1, 'proj-preview-sample', 'file-preview-sample', 'GEN 1:2', 'target.cell.create', 'alice', '{"cellId":"GEN 1:2","value":"Y la tierra estaba desordenada y vacía."}', 0, 0, NULL, 5),
  ('seed-ev-c3-s',  1, 'proj-preview-sample', 'file-preview-sample', 'GEN 1:3', 'source.cell.create', 'alice', '{"cellId":"GEN 1:3","value":"And God said, \"Let there be light,\" and there was light.","type":"verse","canonicalRef":"GEN 1:3"}', 0, 0, NULL, 6),
  ('seed-ev-c3-t',  1, 'proj-preview-sample', 'file-preview-sample', 'GEN 1:3', 'target.cell.create', 'alice', '{"cellId":"GEN 1:3","value":"Y dijo Dios: Sea la luz; y fue la luz."}', 0, 0, NULL, 7);

-- File projection row (0012 shape: role/kind/book_code columns, event_id
-- chain head, provenance + languages in JSON meta).
INSERT INTO files (id, project_id, name, role, kind, book_code, event_id, cell_count, approved_count, word_count, last_edit_at, created_by, created_at, updated_at, meta) VALUES
  ('file-preview-sample', 'proj-preview-sample', 'Genesis 1', 'target', 'codex', 'GEN', 'seed-ev-file', 3, 0, 0, 0, 'alice', 0, 0, '{"source_language":"en","target_language":"es","import_format":"usfm"}');

-- Cell projection rows: paired source + target per verse.
INSERT INTO cells (project_id, file_id, cell_id, side, value, type, canonical_ref, event_id, last_editor, last_edit_at, validated, word_count) VALUES
  ('proj-preview-sample', 'file-preview-sample', 'GEN 1:1', 'source', 'In the beginning God created the heavens and the earth.', 'verse', 'GEN 1:1', 'seed-ev-c1-s', 'alice', 0, 0, 10),
  ('proj-preview-sample', 'file-preview-sample', 'GEN 1:1', 'target', 'En el principio creó Dios los cielos y la tierra.',       'verse', 'GEN 1:1', 'seed-ev-c1-t', 'alice', 0, 0, 9),
  ('proj-preview-sample', 'file-preview-sample', 'GEN 1:2', 'source', 'Now the earth was formless and empty.',                   'verse', 'GEN 1:2', 'seed-ev-c2-s', 'alice', 0, 0, 7),
  ('proj-preview-sample', 'file-preview-sample', 'GEN 1:2', 'target', 'Y la tierra estaba desordenada y vacía.',                 'verse', 'GEN 1:2', 'seed-ev-c2-t', 'alice', 0, 0, 7),
  ('proj-preview-sample', 'file-preview-sample', 'GEN 1:3', 'source', 'And God said, "Let there be light," and there was light.', 'verse', 'GEN 1:3', 'seed-ev-c3-s', 'alice', 0, 0, 11),
  ('proj-preview-sample', 'file-preview-sample', 'GEN 1:3', 'target', 'Y dijo Dios: Sea la luz; y fue la luz.',                  'verse', 'GEN 1:3', 'seed-ev-c3-t', 'alice', 0, 0, 8);
