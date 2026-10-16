// Which cells the UPSTREAM DELETED, as one SQL predicate. (AQU-1564)
//
// A live link never deletes a downstream row when the upstream deletes the
// cell. `source.cell.mirror { deleted: true }` stamps `cells.tombstoned_at` on
// the downstream's shared source row instead (AQU-476 §5), so a translation
// already made against that line stays in `cells` and the Upstream changes
// panel can show it as "this line was removed upstream". The row is a review
// item. It is not work: the line no longer exists in the source the downstream
// translates, so it must not size the file — not in `files.cell_count`, not in
// a progress denominator, and its orphaned translation not in a numerator.
//
// The flag lives where `hidden_at` lives, on the SHARED SOURCE ROW
// (`side = 'source' AND target_lang = ''`): the mirror only ever writes that
// row, and a target row never carries it. So the two forms below mirror the
// two in hidden-cells-scope.ts, and every caller that already resolves
// visibility from the source row resolves this from the same alias. Unlike
// `hidden_at` there is no client copy to keep in step — the client never sees
// the column; it learns of tombstones from the stale-source endpoint.

/**
 * `<alias>.tombstoned_at IS NULL` — "the upstream has not deleted this SOURCE
 * row's cell".
 *
 * Always give it the SOURCE alias, for the reason visibleSourceSql gives: a
 * target row reads NULL here on every row, so nothing would ever be excluded.
 * NULL-safe in the LEFT JOIN shape the files counters use — an absent source
 * row reads as live, which keeps the all-null row of an empty file.
 */
export function liveSourceSql(alias: string): string {
  return `${alias}.tombstoned_at IS NULL`
}

/**
 * The set form: `<cellIdExpr> NOT IN (<this file's tombstoned cell ids>)`, for
 * the grouped `cell_count` scan that must stay Sort-free and index-only.
 *
 * Same reasons as visibleCellIdSql, which this sits beside in the counter
 * recompute. A correlated NOT EXISTS turns into a Merge Anti Join that sorts
 * the inner side, and a bare `tombstoned_at IS NULL` in that scan would need
 * the heap — `tombstoned_at` is not in `cells_pkey` — which turns the Index
 * Only Scan the guardrail pins (hot-query-plans.test.ts) into a heap fetch per
 * row of every file on every commit. Collected once into a hashed subplan, the
 * outer scan stays exactly as it was; the partial index `idx_cells_tombstoned`
 * makes the subplan read only the tombstoned rows, and a file with none — every
 * file outside a live-linked downstream — pays an empty probe.
 *
 * `NOT IN` is safe for the same reason: `cell_id` is in the primary key and can
 * never be NULL. Do not widen the subquery to a nullable column.
 */
export function liveCellIdSql(
  cellIdExpr: string,
  projectExpr: string,
  fileExpr: string,
): string {
  return `${cellIdExpr} NOT IN (
    SELECT tombstoned_src.cell_id FROM cells tombstoned_src
     WHERE tombstoned_src.project_id = ${projectExpr}
       AND tombstoned_src.file_id = ${fileExpr}
       AND tombstoned_src.side = 'source'
       AND tombstoned_src.tombstoned_at IS NOT NULL
  )`
}
