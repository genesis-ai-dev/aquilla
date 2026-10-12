-- 0133_drop_reference_bibles.sql — AQU-1573 (revert)
--
-- The reference-Bible feature (PR #1080) is reverted: quoted verses are to
-- come from the versification tool, not from text stored in this database.
--
-- 0131_reference_bibles.sql created these two tables and was applied to the
-- dev database before the revert, which deleted that file. Deleting a
-- migration file undoes nothing on a database that already ran it, so this
-- drops what it created. Dropping a table also drops its app_runtime grants.
--
-- Production never applied 0131, so this is a no-op there and on any fresh
-- database. Nothing unrecoverable is lost: the rows were loaded from
-- public-domain text committed to this repository.
--
-- Idempotent: IF EXISTS. Verses first, since they reference versions.

DROP TABLE IF EXISTS reference_bible_verses;
DROP TABLE IF EXISTS reference_bible_versions;
