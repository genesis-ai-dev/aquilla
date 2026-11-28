/**
 * AQU-2459 Phase B: Assignment member cells across BOTH materialized and virtual
 * source files without mutating the `assignment_member_cells` database view
 * (keeping migration 0214 100% additive for zero-downtime production rollouts).
 *
 * - Non-virtual files (`COALESCE(f.source_virtual, FALSE) = FALSE`): read through
 *   the existing `assignment_member_cells` view (live range resolution for
 *   `assignment_scopes` + snapshot intersection for explicit cell lists).
 * - Virtual files (`f.source_virtual = TRUE AND f.deleted_at IS NULL`): serve
 *   directly from `assignment_cells` (populated from the R2 revision manifest on
 *   `assignment.create` and refreshed on revision `N > 1`), excluding any sparse
 *   source overlay tombstoned via `source.cell.delete`.
 */
export const ASSIGNMENT_MEMBER_CELLS_SQL = `(
  SELECT amc.project_id, amc.assignment_id, amc.file_id, amc.cell_id,
         amc.canonical_ref, amc.start_ms, amc.type
    FROM assignment_member_cells amc
    LEFT JOIN files f ON f.project_id = amc.project_id AND f.id = amc.file_id
   WHERE COALESCE(f.source_virtual, FALSE) = FALSE
  UNION ALL
  SELECT a.project_id, ac.assignment_id, ac.file_id, ac.cell_id,
         COALESCE(c.canonical_ref, ac.canonical_ref) AS canonical_ref,
         COALESCE(c.start_ms, ac.start_ms)           AS start_ms,
         COALESCE(c.type, ac.type)                   AS type
    FROM assignment_cells ac
    JOIN assignments a ON a.assignment_id = ac.assignment_id
    JOIN files f ON f.project_id = a.project_id AND f.id = ac.file_id
                AND f.deleted_at IS NULL AND f.source_virtual = TRUE
    LEFT JOIN cells c ON c.project_id = a.project_id AND c.file_id = ac.file_id
                     AND c.cell_id = ac.cell_id AND c.side = 'source'
                     AND c.tombstoned_at IS NULL
   WHERE NOT EXISTS (
     SELECT 1 FROM cells dt
      WHERE dt.project_id = a.project_id AND dt.file_id = ac.file_id
        AND dt.cell_id = ac.cell_id AND dt.side = 'source'
        AND dt.tombstoned_at IS NOT NULL
   )
)`
