-- DOCX R2 round-trip: file_source_blobs becomes a pointer; cells gain a
-- stable source paragraph anchor for in-place reinsertion.
-- Mirrored in db/postgres/schema.sql. (Originally mis-filed under
-- auth-worker/migrations/0035 — that targets D1, but these are Neon tables.)
ALTER TABLE file_source_blobs ADD COLUMN IF NOT EXISTS r2_key TEXT;
ALTER TABLE file_source_blobs ADD COLUMN IF NOT EXISTS size_bytes BIGINT;
ALTER TABLE file_source_blobs ALTER COLUMN raw_source DROP NOT NULL;

ALTER TABLE cells ADD COLUMN IF NOT EXISTS source_location TEXT;
