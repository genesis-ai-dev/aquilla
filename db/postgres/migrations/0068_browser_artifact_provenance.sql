-- 0068_browser_artifact_provenance.sql
--
-- AQU-635: browser imports now write the same immutable artifact ledger as
-- agent imports. A browser session has a user identity but no API credential,
-- so credential_id must be nullable; API-uploaded rows continue to require and
-- retain their credential id in application validation.

ALTER TABLE artifacts
  ALTER COLUMN credential_id DROP NOT NULL;

COMMENT ON COLUMN artifacts.credential_id IS
  'API credential that uploaded the artifact; NULL for authenticated browser imports.';
