-- 0192_project_import_min_role_column.sql — AQU-2306
--
-- A project's own, stricter-only import floor (AQU-2305), projected out of the
-- settings blob so the org's Security page can say "N projects are stricter
-- than this" under "Who can import files" — and name them — without parsing
-- every project's multi-MB blob. The same pattern as the two visibility floors
-- (0174) and the media defaults (0176): NULL unless the key holds a JSON
-- number, because `->>` cannot tell the number 600 from the string "600" and a
-- floor read off a string would be a permission decided by a typo.
--
-- Nothing authorizes off this column: the import gate resolves the floor in
-- sync-worker (events/import-authority.ts). This is a reporting projection.
--
-- Idempotent; a database loaded from schema.sql already has it.
ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS import_min_role TEXT
    GENERATED ALWAYS AS (CASE WHEN jsonb_typeof((settings::jsonb) -> 'importMinRole') = 'number' THEN (settings::jsonb) ->> 'importMinRole' END) STORED;
