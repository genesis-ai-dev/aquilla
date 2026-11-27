-- AQU-2459 Phase B: Pure virtual source cells + content-hash staleness pins.
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

ALTER TABLE files ADD COLUMN IF NOT EXISTS source_virtual BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE cells ADD COLUMN IF NOT EXISTS source_content_hash TEXT;

-- AQU-2459 Phase B (assignments): virtual source files have zero `side = 'source'`
-- rows in Postgres `cells`. Carry the grouping columns on `assignment_cells` and
-- let `assignment_member_cells` serve virtual files from `assignment_cells`
-- (populated from the manifest on `assignment.create` and refreshed on revision).
ALTER TABLE assignment_cells ADD COLUMN IF NOT EXISTS canonical_ref TEXT;
ALTER TABLE assignment_cells ADD COLUMN IF NOT EXISTS start_ms INTEGER;
ALTER TABLE assignment_cells ADD COLUMN IF NOT EXISTS type TEXT;

CREATE OR REPLACE VIEW assignment_member_cells WITH (security_invoker = true) AS
  SELECT a.project_id, ac.assignment_id, ac.file_id, ac.cell_id,
         COALESCE(c.canonical_ref, ac.canonical_ref) AS canonical_ref,
         COALESCE(c.start_ms, ac.start_ms)           AS start_ms,
         COALESCE(c.type, ac.type)                   AS type
    FROM assignment_cells ac
    JOIN assignments a ON a.assignment_id = ac.assignment_id
    JOIN files f ON f.project_id = a.project_id AND f.id = ac.file_id AND f.deleted_at IS NULL
    LEFT JOIN cells c ON c.project_id = a.project_id AND c.file_id = ac.file_id
                     AND c.cell_id = ac.cell_id AND c.side = 'source'
                     AND c.tombstoned_at IS NULL
   WHERE (
     (f.source_virtual = TRUE AND NOT EXISTS (
       SELECT 1 FROM cells dt
        WHERE dt.project_id = a.project_id AND dt.file_id = ac.file_id
          AND dt.cell_id = ac.cell_id AND dt.side = 'source'
          AND dt.tombstoned_at IS NOT NULL
     ))
     OR (
       f.source_virtual = FALSE
       AND c.cell_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM assignment_scopes s WHERE s.assignment_id = ac.assignment_id
       )
     )
   )
  UNION ALL
  SELECT a.project_id, s.assignment_id, c.file_id, c.cell_id,
         c.canonical_ref, c.start_ms, c.type
    FROM assignment_scopes s
    JOIN assignments a ON a.assignment_id = s.assignment_id
    JOIN files f ON f.project_id = a.project_id AND f.id = s.file_id
                AND f.deleted_at IS NULL AND f.source_virtual = FALSE
    JOIN cells c ON c.project_id = a.project_id AND c.file_id = s.file_id
                AND c.side = 'source'
    LEFT JOIN cell_plan_keys ik ON ik.project_id = c.project_id AND ik.file_id = c.file_id
                               AND ik.cell_id = c.cell_id
   WHERE (
     s.chapter = ''
     OR COALESCE(
          NULLIF(TRIM(SPLIT_PART(COALESCE(c.canonical_ref, ''), ':', 1)), ''),
          ik.section_key,
          CASE
            WHEN TRIM(SPLIT_PART(COALESCE(c.canonical_ref, ''), ':', 1)) <> ''
              THEN TRIM(SPLIT_PART(COALESCE(c.canonical_ref, ''), ':', 1))
            WHEN c.start_ms IS NOT NULL
              THEN 't:' || LPAD(((c.start_ms / 300000) * 300000)::text, 12, '0')
            ELSE ''
          END
        ) = s.chapter
   );
