-- 0018_file_source_blobs.sql
-- Side-car raw-bytes storage for imported source files.
--
-- For formats where round-trip fidelity matters (USFM first, eventually DOCX
-- and PPTX), we store the imported file's raw bytes alongside the parsed
-- cells. Export = walk the raw bytes and substitute each verse's current
-- translation. This preserves every marker, footnote, paragraph break,
-- character marker, intro/header line, and even the comment lines — bytes
-- we don't touch can't be lost.
--
-- One row per source file_id. Written once at import (UPSERT on re-import).
-- Format is the parser/serializer pair to use on export (e.g. "usfm"). Files
-- imported before this migration have no row here; export endpoint returns
-- 404 for them and the UI tells the user to re-import to enable round-trip.

CREATE TABLE file_source_blobs (
    file_id     TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL,
    format      TEXT NOT NULL,        -- "usfm" | future formats
    raw_source  TEXT NOT NULL,        -- original bytes (UTF-8). Max ~1MiB per D1 cell.
    created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_file_source_blobs_project ON file_source_blobs(project_id);
