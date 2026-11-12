-- 0160_diarization_jobs_owner_and_sweep.sql — AQU-1855
--
-- Two pieces of bookkeeping the diarization reaper and the concurrency cap need.
--
-- `created_by` records which user started the job. Until now the row named only
-- the project and file, so there was nothing to cap a single user against: a
-- user could hold open as many GPU jobs as they had projects. It is nullable
-- because every pre-existing row predates the column — an unattributed job
-- counts toward its project's cap and no user's.
--
-- The index serves the sweep and the cap, which both ask the same question
-- ("which jobs are still live, and how old are they?") and which previously had
-- to fall back to the (project_id, file_id) index or a scan.
--
-- Idempotent. A database loaded from schema.sql already has both.

ALTER TABLE diarization_jobs
  ADD COLUMN IF NOT EXISTS created_by BIGINT;

CREATE INDEX IF NOT EXISTS idx_diarization_jobs_live
  ON diarization_jobs(status, updated_at);
