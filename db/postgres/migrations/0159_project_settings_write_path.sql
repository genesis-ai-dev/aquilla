-- Migration 0159: project the keys POST /events reads out of
-- project_settings.settings (AQU-1840).
--
-- THE PROBLEM. Every target-lane write authorizes through the archived-lane
-- check, which read
--
--   SELECT settings FROM project_settings WHERE project_id = ?
--
-- and JSON.parse'd the result in the Worker. `settings` is TEXT holding blobs
-- the table's own column comment calls multi-MB, so each autosave flush
-- detoasted and shipped megabytes to answer "is this lane archived?". A
-- per-request memo (perf/events-write-path) cut it to ONE such load per
-- request, which is where it still was: one multi-MB load per flush, plus the
-- same load answering timingLocked (retime), allowTrackEditing (track patch),
-- the validation-threshold and named-validator policy (validate), and
-- harmonize_min_role (harmonize).
--
-- THE FIX. Same shape as 0054 / 0123 / 0150: STORED generated columns that pay
-- the parse once, when the settings are written, and cannot drift from the
-- JSON. The `wp_` prefix marks the set as the write path's projection — these
-- eleven keys are exactly what sync-worker/src/events/request-cache.ts reads,
-- so after this no events-route statement names `settings`.
--
-- WHY JSONB AND NOT `->>` TEXT, as validation_count and friends above are: the
-- write path's guards are typed. `resolveTimingLocked` unlocks a timeline only
-- on exactly `false`, validation honours `validationCount` only when it is a
-- number, named-validator lists only when `Array.isArray`. `->>` renders JSON
-- false and the JSON string "false" identically as 'false', and the number 3
-- and the string "3" identically as '3' — projecting through TEXT would unlock
-- a locked timeline and apply a threshold the old code ignored. `->` keeps the
-- value's JSON type, so the driver hands the Worker the same JS value
-- JSON.parse(settings) handed it.
--
-- WHAT IT COSTS ON WRITE. Each generated column casts the blob for itself, so
-- a settings write now parses it eleven more times (0150 measured one parse at
-- about 7 ms per MB on dev; project_settings has one row per project, and
-- writes to it are a human saving Settings or the migrate-settings route). An
-- UPDATE that leaves `settings` alone recomputes nothing. That is the trade
-- this ticket asks for: a rare settings save pays, every cell commit stops
-- paying.
--
-- WHAT IT COSTS TO APPLY. Adding STORED columns rewrites the table under an
-- ACCESS EXCLUSIVE lock: every blob is read and parsed, and nothing can read
-- project_settings until the rewrite ends. All eleven are added in ONE
-- statement, so the table is rewritten once. Apply it at a quiet time, as with
-- 0123 and 0150.
--
-- DEPLOY ORDER. Apply this before the sync-worker that reads these columns —
-- but it is not a safety requirement: on a database without them the reader
-- falls back to the blob read it did before (request-cache.ts), so the
-- authority answers are unchanged either way.

BEGIN;
-- Give up after 5s of WAITING for the lock (this does not limit how long the
-- rewrite then holds it), so the ALTER cannot queue every reader behind one
-- long-running transaction. If this times out nothing has changed: run the
-- migration again.
SET LOCAL lock_timeout = '5s';

ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS wp_archived_lanes JSONB
    GENERATED ALWAYS AS ((settings::jsonb) -> 'archivedLanes') STORED,
  ADD COLUMN IF NOT EXISTS wp_timing_locked JSONB
    GENERATED ALWAYS AS ((settings::jsonb) -> 'timingLocked') STORED,
  ADD COLUMN IF NOT EXISTS wp_allow_track_editing JSONB
    GENERATED ALWAYS AS ((settings::jsonb) -> 'allowTrackEditing') STORED,
  ADD COLUMN IF NOT EXISTS wp_validation_count JSONB
    GENERATED ALWAYS AS ((settings::jsonb) -> 'validationCount') STORED,
  ADD COLUMN IF NOT EXISTS wp_validation_role_floor JSONB
    GENERATED ALWAYS AS ((settings::jsonb) -> 'validationRoleFloor') STORED,
  ADD COLUMN IF NOT EXISTS wp_validation_named_users JSONB
    GENERATED ALWAYS AS ((settings::jsonb) -> 'validationNamedUsers') STORED,
  ADD COLUMN IF NOT EXISTS wp_allow_self_validation JSONB
    GENERATED ALWAYS AS ((settings::jsonb) -> 'allowSelfValidation') STORED,
  ADD COLUMN IF NOT EXISTS wp_validation_role_floor_audio JSONB
    GENERATED ALWAYS AS ((settings::jsonb) -> 'validationRoleFloorAudio') STORED,
  ADD COLUMN IF NOT EXISTS wp_validation_named_users_audio JSONB
    GENERATED ALWAYS AS ((settings::jsonb) -> 'validationNamedUsersAudio') STORED,
  ADD COLUMN IF NOT EXISTS wp_allow_self_validation_audio JSONB
    GENERATED ALWAYS AS ((settings::jsonb) -> 'allowSelfValidationAudio') STORED,
  ADD COLUMN IF NOT EXISTS wp_harmonize_min_role JSONB
    GENERATED ALWAYS AS ((settings::jsonb) -> 'harmonize_min_role') STORED;
COMMIT;
