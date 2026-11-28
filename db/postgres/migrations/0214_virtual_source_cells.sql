-- AQU-2459 Phase B: Pure virtual source cells + content-hash staleness pins.
--
-- 100% additive migration (safe to apply ahead of worker rollout):
--
-- 1. `files.source_virtual`: when TRUE, the file's source cells live solely in
--    its head R2 revision manifest (`file_revisions.manifest_r2_key`) rather
--    than as N rows in `cells`. Any manual post-import source edit/hide/split
--    lands as a sparse `side = 'source'` overlay row in `cells` and is merged
--    over the manifest on read. Legacy files default to FALSE and keep their
--    materialized `cells` rows untouched.
--
-- 2. `cells.source_content_hash`: the 122-bit content hash (`contentHashOf`) of
--    the source unit the translator committed or repinned against. Lets
--    `stale-source-route` evaluate staleness directly against a virtual
--    manifest's `contentHash` (including Weblate's revert-to-fresh rule) with
--    zero dependency on Postgres source rows or event payload joins.
--
-- 3. `assignment_cells.{canonical_ref,start_ms,type}`: grouping columns for
--    assignments on virtual source files, populated from the revision manifest
--    on `assignment.create` and refreshed on revision `N > 1`.

ALTER TABLE files ADD COLUMN IF NOT EXISTS source_virtual BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE cells ADD COLUMN IF NOT EXISTS source_content_hash TEXT;
ALTER TABLE assignment_cells ADD COLUMN IF NOT EXISTS canonical_ref TEXT;
ALTER TABLE assignment_cells ADD COLUMN IF NOT EXISTS start_ms INTEGER;
ALTER TABLE assignment_cells ADD COLUMN IF NOT EXISTS type TEXT;
