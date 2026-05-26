-- Migration 0015: threaded comments projection table
--
-- Adds the `comments` table to hold the projected state for the
-- comment.create / comment.edit / comment.delete / comment.resolve event family.
--
-- Design decisions:
--   - scope_kind / file_id / cell_id store the CommentScope discriminated union
--     as flat columns (fast indexed lookups, no JSON parsing in the hot path).
--   - parent_comment_id = NULL means top-level; non-null means reply.
--   - resolved is stored as INTEGER (0/1) for SQLite compatibility.
--   - deleted_at is a soft-delete column: comment.delete sets body='' and
--     deleted_at=<serverTs> so threaded replies remain navigable and audit
--     history is preserved.
--   - author_id stores the raw username string (matches events.author).
--   - author_label is a human-readable display name (may be null if not supplied).

CREATE TABLE IF NOT EXISTS comments (
  comment_id        TEXT    PRIMARY KEY,
  project_id        TEXT    NOT NULL,
  scope_kind        TEXT    NOT NULL,    -- 'cell' | 'file' | 'project'
  file_id           TEXT,               -- nullable; set for cell/file scope
  cell_id           TEXT,               -- nullable; set for cell scope
  parent_comment_id TEXT,               -- null = top-level thread root
  body              TEXT    NOT NULL,
  resolved          INTEGER NOT NULL DEFAULT 0,
  author_id         TEXT    NOT NULL,
  author_label      TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  deleted_at        INTEGER             -- null = live; non-null = soft-deleted
);

-- Primary lookup: all comments for a project, optionally filtered by scope.
CREATE INDEX IF NOT EXISTS comments_project_scope
  ON comments(project_id, scope_kind, file_id, cell_id);

-- Thread tree walk: all replies to a given top-level comment.
CREATE INDEX IF NOT EXISTS comments_thread
  ON comments(project_id, parent_comment_id);
