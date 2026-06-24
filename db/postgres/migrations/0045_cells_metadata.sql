-- Migration 0045: extensible per-cell metadata bucket (OBS parity).
--
-- Adds a nullable JSONB `metadata` column to `cells`. It holds an open-ended
-- object that mirrors the extensible `source.cell.create` event payload
-- (`metadata?: Record<string, unknown>`). The first consumer is Open Bible
-- Stories, which populates one frame image per cell as:
--   { "attachments": [{ "type": "image", "url": "https://…", "alt": "…" }] }
-- Future attachment kinds (gif/video/audio) and other keys can be added
-- without further schema changes — that's the point of the JSONB bucket.
--
-- Nullable, no default: a cell with no metadata stores SQL NULL.

ALTER TABLE cells ADD COLUMN IF NOT EXISTS metadata JSONB;
