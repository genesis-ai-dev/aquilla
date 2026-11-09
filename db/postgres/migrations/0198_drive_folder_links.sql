-- 0198_drive_folder_links.sql — a Google Drive folder kept in sync with a project.
--
-- A project lead links a Drive folder that is shared with the Aquilla Google
-- service account. A per-link Durable Object (sync-worker DriveFolderPoller)
-- lists the folder every few seconds; each Word file or Google Doc whose
-- Drive version moved is fetched, parsed and written as ONE file revision
-- (AQU-2459), so translations stay on their paragraphs and open editors reload.
--
--   * drive_folder_links — one folder per row. The poller writes as `user_id`,
--     with that user's LIVE project role, so a lead who loses access stops the
--     sync. `last_error` / `last_synced_at` are what the UI shows.
--   * drive_folder_files — the cursor: which Aquilla file each Drive file
--     became, the Drive `version` last applied, and the sha256 of the bytes it
--     produced (an unchanged export after a metadata-only edit is a no-op).

CREATE TABLE IF NOT EXISTS drive_folder_links (
  id              TEXT PRIMARY KEY,         -- uuid
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  folder_id       TEXT NOT NULL,
  folder_name     TEXT,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username        TEXT NOT NULL,
  last_synced_at  BIGINT,
  last_error      TEXT,
  created_at      BIGINT NOT NULL,
  UNIQUE (project_id, folder_id)
);

CREATE TABLE IF NOT EXISTS drive_folder_files (
  link_id         TEXT NOT NULL REFERENCES drive_folder_links(id) ON DELETE CASCADE,
  drive_file_id   TEXT NOT NULL,
  file_id         TEXT NOT NULL,
  drive_version   TEXT NOT NULL,
  artifact_sha256 TEXT,
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (link_id, drive_file_id)
);
