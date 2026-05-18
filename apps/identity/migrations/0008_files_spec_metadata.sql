-- Migration: 0008_files_spec_metadata.sql
-- Description: Add the file-metadata fields the spec's `file.create` payload
--   carries (03-data-model.md §"File"): role, kind, book_code, source_file_id,
--   anchor_file_id, r2_key, import_format, parser_version. The current
--   `files.file_type` column is kept for backward compatibility with rows the
--   pre-spec event-projection writes; new `file.create` events should populate
--   role + kind (and the optional metadata) directly.
--
--   - role          — semantic side of the file: 'source', 'target',
--                     'dictionary', 'translationNotes' (per spec §"File" and
--                     events.file.create payload).
--   - kind          — file shape / format intent: 'codex', 'usfm', 'docx',
--                     'pptx', 'vtt', 'srt', 'txt', 'md'. Distinct from
--                     `import_format` which records what the *original blob in
--                     R2* was parsed as (which is normally the same value but
--                     could diverge for synthesized files).
--   - book_code     — scripture book identifier ('GEN', 'EXO', ...); null for
--                     non-scripture files.
--   - source_file_id — for target-side files that pair with a specific source
--                      file across the project (e.g., GenesisTarget paired
--                      with GenesisSource). Spec §"Cell" pairing uses
--                      shared cell_ids; this column is the file-level mirror.
--   - anchor_file_id — ordering anchor for the file's position in the project
--                      browser (parallel of cells.anchor_cell_id).
--   - r2_key        — key into the SNAPSHOTS R2 bucket where the original
--                     imported blob lives (per AD-4 + source-import feature).
--                     Null for non-imported files (e.g., target-side files
--                     created in-app).
--   - import_format — the source format the original blob was parsed as
--                     ('usfm', 'docx', 'vtt', ...). Drives a future re-parse.
--   - parser_version — the parser revision that produced this file's cells;
--                      enables AD-4's re-parse-against-newer-parser path.
--
-- No backfill — no users yet (project_no_users_yet memory); existing rows
-- will simply have NULLs in the new columns and the legacy `file_type` value
-- they already carry.

ALTER TABLE files ADD COLUMN role           TEXT;
ALTER TABLE files ADD COLUMN kind           TEXT;
ALTER TABLE files ADD COLUMN book_code      TEXT;
ALTER TABLE files ADD COLUMN source_file_id TEXT REFERENCES files(id);
ALTER TABLE files ADD COLUMN anchor_file_id TEXT REFERENCES files(id);
ALTER TABLE files ADD COLUMN r2_key         TEXT;
ALTER TABLE files ADD COLUMN import_format  TEXT;
ALTER TABLE files ADD COLUMN parser_version TEXT;

-- "Which target files pair with this source file?" — drives the linked-target
-- file-pairing UI per AD-9. Partial-index to avoid bloating on
-- self-contained projects where source_file_id is NULL on every row.
CREATE INDEX idx_files_source_file
  ON files(source_file_id) WHERE source_file_id IS NOT NULL;

-- Same shape for the in-project ordering anchor.
CREATE INDEX idx_files_anchor_file
  ON files(anchor_file_id) WHERE anchor_file_id IS NOT NULL;

-- Role-scoped lookups inside a project (the file browser groups source vs
-- target). Partial-skips NULL until everyone's on the new payload.
CREATE INDEX idx_files_project_role
  ON files(project_id, role) WHERE role IS NOT NULL;
