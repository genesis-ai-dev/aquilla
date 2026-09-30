-- AQU-1480: transient acoustic alignment jobs; source content remains event-sourced.
CREATE TABLE IF NOT EXISTS alignment_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  audio_object TEXT NOT NULL,
  fetch_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  script TEXT NOT NULL,
  language TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alignment_jobs_file
  ON alignment_jobs(project_id, file_id);
