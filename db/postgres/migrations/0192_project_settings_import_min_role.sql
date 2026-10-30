-- Migration 0192: project this project's own import floor out of
-- project_settings.settings (AQU-2305).
--
-- WHY. AQU-2304 gave an org one answer for "who can import files"
-- (`importMinRole` in org_settings). A project may now store the same key in
-- its own settings blob to be STRICTER than its org, and the sync-worker's
-- `file.create` perimeter has to read it on every source import. The write
-- path reads project settings through the `wp_` projection 0171 added
-- (sync-worker/src/events/write-path-settings.ts) precisely so no events-route
-- statement opens the multi-MB `settings` TEXT column; this key joins that
-- projection rather than becoming the one read that reopens the blob.
--
-- JSONB and not `->>` TEXT, for 0171's reason: the reader's guard is typed
-- (`typeof === 'number'`), and `->>` renders the number 500 and the string
-- "500" identically, so a project could acquire a floor through a string the
-- old code ignored. `->` keeps the value's JSON type, so the driver hands the
-- Worker the same JS value `JSON.parse(settings)` would have.
--
-- WHAT IT COSTS TO APPLY. Adding a STORED generated column rewrites the table
-- under an ACCESS EXCLUSIVE lock: every blob is read and parsed, and nothing
-- can read project_settings until the rewrite ends. One column, one statement,
-- one rewrite. Apply it at a quiet time, as with 0171.
--
-- DEPLOY ORDER. Apply this before the sync-worker that reads the column — but
-- it is not a safety requirement: on a database without it the reader falls
-- back to the blob read and narrows it in the Worker (request-cache.ts), so
-- the authority answer is identical either way.

BEGIN;
-- Give up after 5s of WAITING for the lock (this does not limit how long the
-- rewrite then holds it), so the ALTER cannot queue every reader behind one
-- long-running transaction. If this times out nothing has changed: run the
-- migration again.
SET LOCAL lock_timeout = '5s';

ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS wp_import_min_role JSONB
    GENERATED ALWAYS AS ((settings::jsonb) -> 'importMinRole') STORED;
COMMIT;
