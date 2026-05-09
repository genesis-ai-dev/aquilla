-- Migration 002: cell subsystem schema for the editor refactor.
-- Adds the full cell-related data model split between cell-keyed entities
-- (threads, thread_messages, cell_attachments) and edit-keyed signoffs
-- (validations, waivers, backtranslations) per
-- DATA_PERSISTENCE_PLAN.md §4.10–§4.12.
--
-- Cell-keyed columns added to existing `cells`:
--   - label: user-applied label (cell-keyed, LWW with version-check)
--   - backtranslation_pinned_id: optional FK to backtranslations.id, pinning
--     the UI to a specific version's back-translation.

-- ───── cells: cell-keyed columns ─────

ALTER TABLE cells ADD COLUMN label TEXT;
ALTER TABLE cells ADD COLUMN backtranslation_pinned_id TEXT;

-- ───── Edit-keyed signoffs ─────
-- Each row carries text_snapshot so it stays interpretable without an FK
-- into cell_revisions. UI renders staleness as "validated at v3, current is v4".

CREATE TABLE validations (
  id                TEXT PRIMARY KEY,
  cell_id           TEXT NOT NULL,
  cell_version_at   INTEGER NOT NULL,
  text_snapshot     TEXT NOT NULL,
  rule_id           TEXT,
  validator_id      TEXT NOT NULL,
  validated_at      INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'validated',
  notes             TEXT,
  seq               INTEGER NOT NULL,
  org_id            TEXT NOT NULL,
  UNIQUE(cell_id, cell_version_at, rule_id, validator_id)
);
CREATE INDEX idx_validations_cell    ON validations(cell_id, cell_version_at);
CREATE INDEX idx_validations_active  ON validations(cell_id, status)
                                       WHERE status = 'validated';

CREATE TABLE waivers (
  id                TEXT PRIMARY KEY,
  cell_id           TEXT NOT NULL,
  cell_version_at   INTEGER NOT NULL,
  text_snapshot     TEXT NOT NULL,
  rule_id           TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'proposed',
  justification     TEXT NOT NULL,
  proposed_by       TEXT NOT NULL,
  proposed_at       INTEGER NOT NULL,
  resolved_by       TEXT,
  resolved_at       INTEGER,
  seq               INTEGER NOT NULL,
  org_id            TEXT NOT NULL
);
CREATE INDEX idx_waivers_cell        ON waivers(cell_id, cell_version_at);
CREATE INDEX idx_waivers_active      ON waivers(cell_id, rule_id, state)
                                       WHERE state IN ('proposed','approved');

CREATE TABLE backtranslations (
  id                TEXT PRIMARY KEY,
  cell_id           TEXT NOT NULL,
  cell_version_at   INTEGER NOT NULL,
  text_snapshot     TEXT NOT NULL,
  back_text         TEXT NOT NULL,
  generated_by      TEXT NOT NULL,
  generated_at      INTEGER NOT NULL,
  is_user_edited    INTEGER NOT NULL DEFAULT 0,
  seq               INTEGER NOT NULL,
  UNIQUE(cell_id, cell_version_at)
);
CREATE INDEX idx_backtrans_cell      ON backtranslations(cell_id, cell_version_at);

-- ───── Cell-keyed entities ─────

CREATE TABLE threads (
  id                TEXT PRIMARY KEY,
  cell_id           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  created_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  resolved_by       TEXT,
  resolved_at       INTEGER,
  seq               INTEGER NOT NULL
);
CREATE INDEX idx_threads_cell        ON threads(cell_id, status);

CREATE TABLE thread_messages (
  id                TEXT PRIMARY KEY,
  thread_id         TEXT NOT NULL,
  author_id         TEXT NOT NULL,
  body              TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  seq               INTEGER NOT NULL
);
CREATE INDEX idx_msgs_thread         ON thread_messages(thread_id, created_at);

CREATE TABLE cell_attachments (
  id                TEXT PRIMARY KEY,
  cell_id           TEXT NOT NULL,
  kind              TEXT NOT NULL,
  ref               TEXT,
  blob_key          TEXT,
  display_name      TEXT,
  metadata          TEXT NOT NULL DEFAULT '{}',
  added_by          TEXT NOT NULL,
  added_at          INTEGER NOT NULL,
  seq               INTEGER NOT NULL
);
CREATE INDEX idx_attach_cell         ON cell_attachments(cell_id);
