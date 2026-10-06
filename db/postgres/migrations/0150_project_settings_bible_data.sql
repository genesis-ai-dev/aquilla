-- Migration 0150: the Bible data switches, projected out of project_settings
-- (AQU-1686).
--
-- The Bible Aquifer gate (auth-worker/src/lib/aquifer/gate.ts) read the
-- explicit `bibleResourcesEnabled` switch inline,
--
--   settings::jsonb ->> 'bibleResourcesEnabled'
--
-- on every aquifer route and agent run. `settings` is TEXT holding blobs that
-- run to several MB, and the column comment on project_settings forbids this
-- read: the generated columns beside it exist so that no read path parses the
-- blob. AQU-1686 adds a second switch the server reads, `bibleEnrichments`
-- (one boolean per Bible data enrichment), which autopilot will check per run.
-- Same fix as 0054 and 0123: a STORED generated column pays the parse once,
-- when the settings are written, and cannot drift from the JSON.
--
-- bible_resources_enabled is a NULLABLE BOOLEAN. NULL means the project never
-- made an explicit choice, and the gate then derives the value from the
-- project's scripture files (AQU-460). The expression keeps the gate's old
-- reading exactly: it compared the `->>` text with 'true' and 'false', so the
-- strings "true" and "false" count as well as the JSON booleans, and any other
-- value counts as no choice.
--
-- bible_enrichments is JSONB, like target_lanes, because the reader wants the
-- object. Readers validate it (readBibleEnrichments in
-- db/shared/bible-enrichments.ts): unknown ids and values that are not
-- booleans count as unset.
--
-- WHAT IT COSTS ON WRITE. Each generated column on this table casts the blob
-- for itself, so a settings write now parses it two more times. An UPDATE that
-- leaves `settings` alone recomputes neither column. Not measured for this
-- migration. The sibling projection proposed as 0139 (PR #1174) measured one
-- parse at about 7 ms per MB of blob on dev.
--
-- WHAT IT COSTS TO APPLY. Adding a STORED column rewrites the table under an
-- ACCESS EXCLUSIVE lock: every blob is read and parsed, and nothing can read
-- project_settings until the rewrite ends. Both columns are added in ONE
-- statement, so the table is rewritten once, not twice. Apply it at a quiet
-- time, as with 0123.
--
-- DEPLOY ORDER. Apply this migration BEFORE the auth-worker that reads these
-- columns. On a database without them the gate's settings read fails, the
-- gate treats that as "no explicit choice", and a project that switched Bible
-- data OFF while it has scripture files would get it back on.

BEGIN;
-- Give up after 5s of WAITING for the lock (this does not limit how long the
-- rewrite then holds it), so the ALTER cannot queue every reader behind one
-- long-running transaction. If this times out nothing has changed: run the
-- migration again.
SET LOCAL lock_timeout = '5s';

ALTER TABLE project_settings
  ADD COLUMN IF NOT EXISTS bible_resources_enabled BOOLEAN
    GENERATED ALWAYS AS (
      CASE (settings::jsonb) ->> 'bibleResourcesEnabled'
        WHEN 'true' THEN TRUE
        WHEN 'false' THEN FALSE
      END
    ) STORED,
  ADD COLUMN IF NOT EXISTS bible_enrichments JSONB
    GENERATED ALWAYS AS ((settings::jsonb) -> 'bibleEnrichments') STORED;
COMMIT;
