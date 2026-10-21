-- 0182_assignment_kind.sql — AQU-1969 "Assign validation only"
--
-- Each assignment says what kind of work it hands out. 'translate' is every
-- assignment made before this column existed, and what the Assign dialogs
-- still default to: its progress is the lines validated by anyone in the
-- scope, unchanged. 'validate' hands a person only the approving, and its
-- progress counts THAT person's own approvals in the scope (cell_validators
-- for text, cell_audio_validators for recordings, in the assignment's
-- language) — the auth-worker reads derive it; nothing new is stored.
--
-- A constant default, so Postgres adds the column without rewriting the table
-- and every existing row reads 'translate'.
--
-- Idempotent. A database loaded from schema.sql already has the column.
ALTER TABLE assignments
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'translate'
    CHECK (kind IN ('translate', 'validate'));
