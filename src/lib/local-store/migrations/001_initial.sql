-- Client-side schema. Mirrors a subset of the D1 system of record.
-- See docs/DATA_PERSISTENCE_PLAN.md §4 (D1 schema). Tables here are
-- projections the client needs to query directly; cell_revisions and the
-- raw event log live server-side only and are fetched on demand.

-- Project metadata + sync cursor.
CREATE TABLE project_meta (
  project_id        TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  name              TEXT NOT NULL,
  library_doc_id    TEXT NOT NULL,
  bound_version_id  TEXT NOT NULL,
  source_lang       TEXT NOT NULL,
  target_lang       TEXT NOT NULL,
  last_seq          INTEGER NOT NULL DEFAULT 0,
  snapshot_seq      INTEGER,
  loaded_at         INTEGER NOT NULL
);

CREATE TABLE library_documents (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL,
  name               TEXT NOT NULL,
  format             TEXT NOT NULL,
  usage_kind         TEXT NOT NULL DEFAULT 'source',
  source_lang        TEXT NOT NULL,
  current_version_id TEXT,
  gitlab_origin      TEXT,
  created_by         TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE library_document_versions (
  id                TEXT PRIMARY KEY,
  library_doc_id    TEXT NOT NULL,
  source_hash       TEXT NOT NULL,
  skeleton_hash     TEXT NOT NULL,
  parser_version    TEXT NOT NULL,
  parsed_at         INTEGER NOT NULL,
  cell_count        INTEGER NOT NULL,
  source_meta       TEXT NOT NULL DEFAULT '{}',
  UNIQUE(library_doc_id, source_hash)
);

CREATE TABLE cells (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  scope_id            TEXT NOT NULL,
  address             TEXT NOT NULL,
  ord                 INTEGER NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'text',
  parent_cell_id      TEXT,

  source_text         TEXT NOT NULL,
  source_text_hash    TEXT NOT NULL,
  source_version_id   TEXT NOT NULL,

  translation_text    TEXT NOT NULL DEFAULT '',
  tag_dictionary      TEXT NOT NULL DEFAULT '{}',

  status              TEXT NOT NULL DEFAULT 'empty',
  approved_at_version INTEGER,
  locked_by_user_id   TEXT,

  version             INTEGER NOT NULL DEFAULT 0,
  last_edited_by      TEXT,
  last_edited_at      INTEGER,

  seq                 INTEGER NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,

  org_id              TEXT NOT NULL,
  source_lang         TEXT NOT NULL,
  target_lang         TEXT NOT NULL,

  format_meta         TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_cells_project_seq   ON cells(project_id, seq);
CREATE INDEX idx_cells_project_scope ON cells(project_id, scope_id, ord);
CREATE INDEX idx_cells_status        ON cells(project_id, status);
CREATE INDEX idx_cells_parent        ON cells(parent_cell_id) WHERE parent_cell_id IS NOT NULL;

-- FTS5 over source and translation text for instant in-app search.
CREATE VIRTUAL TABLE cells_fts USING fts5(
  source_text,
  translation_text,
  content='cells',
  content_rowid='rowid'
);

CREATE TRIGGER cells_fts_ai AFTER INSERT ON cells BEGIN
  INSERT INTO cells_fts(rowid, source_text, translation_text)
  VALUES (new.rowid, new.source_text, new.translation_text);
END;

CREATE TRIGGER cells_fts_ad AFTER DELETE ON cells BEGIN
  INSERT INTO cells_fts(cells_fts, rowid, source_text, translation_text)
  VALUES ('delete', old.rowid, old.source_text, old.translation_text);
END;

CREATE TRIGGER cells_fts_au AFTER UPDATE ON cells BEGIN
  INSERT INTO cells_fts(cells_fts, rowid, source_text, translation_text)
  VALUES ('delete', old.rowid, old.source_text, old.translation_text);
  INSERT INTO cells_fts(rowid, source_text, translation_text)
  VALUES (new.rowid, new.source_text, new.translation_text);
END;

-- Recent commits, for the in-app activity feed.
CREATE TABLE commits (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  message     TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_commits_project ON commits(project_id, seq DESC);

-- Client-only: durable queue of pending mutations.
CREATE TABLE outbox (
  local_id         TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  endpoint         TEXT NOT NULL,
  payload          TEXT NOT NULL,
  expected_version INTEGER,
  status           TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_outbox_status  ON outbox(status, created_at);
CREATE INDEX idx_outbox_project ON outbox(project_id);
