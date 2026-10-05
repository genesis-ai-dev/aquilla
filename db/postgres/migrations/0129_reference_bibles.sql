-- Migration 0129 (AQU-1573): reference Bibles for non-Scripture projects.
--
-- A sermon project (Living on the Edge: English sermons into Arabic) must copy
-- every verse a source line cites from the Bible its readers know — Van Dyck
-- for Arabic — instead of translating it fresh. These two tables hold the
-- verse text the drafting prompt and the quote check look up.
--
-- Not project-scoped: the built-in texts are public domain and shared by
-- every project, so there is no project_id and no RLS policy. `org_id` is
-- always NULL for now; licensed partner uploads (a later slice) will set it
-- and every reader already filters `org_id IS NULL`.
--
-- Rows are written only by scripts/reference-bibles.ts (`load`), which runs
-- as the owner role, in one transaction per version, and sets `verse_count`
-- last — so a half-loaded version never reads as installed. Workers only
-- read. `versification` records the verse numbering ('eng' = KJV tradition,
-- which both Van Dyck and the KJV use) so later texts with other numbering
-- can add a mapping.
--
-- After applying this migration, load the texts (safe to re-run):
--   AQUILLA_DATABASE_URL=… npx tsx scripts/reference-bibles.ts load
-- See docs/reference-bibles.md.

CREATE TABLE IF NOT EXISTS reference_bible_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  language_code TEXT NOT NULL,
  language_name TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'ltr' CHECK (direction IN ('ltr', 'rtl')),
  versification TEXT NOT NULL DEFAULT 'eng',
  printing TEXT,
  license TEXT NOT NULL,
  source TEXT NOT NULL,
  org_id BIGINT,
  verse_count INTEGER NOT NULL DEFAULT 0,
  content_sha256 TEXT,
  loaded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reference_bible_verses (
  version_id TEXT NOT NULL REFERENCES reference_bible_versions(id) ON DELETE CASCADE,
  book TEXT NOT NULL,
  chapter INTEGER NOT NULL CHECK (chapter > 0),
  verse INTEGER NOT NULL CHECK (verse > 0),
  text TEXT NOT NULL,
  PRIMARY KEY (version_id, book, chapter, verse)
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT SELECT ON reference_bible_versions TO app_runtime;
    GRANT SELECT ON reference_bible_verses TO app_runtime;
  END IF;
END $$;
