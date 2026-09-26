// Which cells are HIDDEN, as one SQL predicate — this worker's copy. (AQU-1424)
//
// "Hide cell" (AQU-1422) parks a cell without deleting anything. AQU-1424 is the
// other half of that promise: a parked cell stops being WORK, so it leaves
// progress, drafting, autopilot, the agent's cell selection and search. Here
// that means the autopilot readiness counts, `selectCellPairs` (the ONE selector
// both the autopilot tick and the agent's read/draft tools go through) and the
// agent's search tool.
//
// DUPLICATED, not imported: `sync-worker/src/events/hidden-cells-scope.ts` is
// the same two functions with the same contract, and the two packages have no
// import path between them (separate package-locks, separate builds). Change one
// and change the other; the client's third mirror is src/lib/cells/hidden.ts.
//
// WHERE THE FLAG LIVES, and why there are two forms. `cells.hidden_at`
// (migration 0112) sits only on the SHARED SOURCE ROW
// (`side = 'source' AND target_lang = ''`), because hiding is per CELL, not per
// lane. A query already scanning source rows asks the row it has; a query that
// matched a row on EITHER side has to go look at the source row, because a
// target row carries no flag of its own — and a target row created AFTER the
// hide (a collaborator's in-flight translation, which must survive) is exactly
// the row that must not come back.
//
// PREREQUISITE: migration 0112 must be applied.

/**
 * `<alias>.hidden_at IS NULL` — "this SOURCE row is visible". Pass the SOURCE
 * alias; pointed at a target row it reads NULL on every row and excludes
 * nothing, which looks like the feature quietly not working.
 *
 * An absent alias row (an outer join that found nothing) also reads as visible,
 * which is what the source-less rows of AQU-1068 need.
 */
export function visibleSourceSql(alias: string): string {
  return `${alias}.hidden_at IS NULL`
}

/**
 * The anti-join form — "the cell this row belongs to is not parked" — for a row
 * whose side is unknown or is the target.
 *
 * `alias` may be empty for an unaliased `FROM cells`, in which case the
 * correlation names the table.
 *
 * Cost: one indexed probe, covered by 0112's partial index
 * (`idx_cells_hidden ... WHERE hidden_at IS NOT NULL`), so a project with
 * nothing hidden pays an empty lookup.
 */
export function notHiddenSql(alias = 'cells'): string {
  return `NOT EXISTS (
    SELECT 1 FROM cells hidden_src
     WHERE hidden_src.project_id = ${alias}.project_id
       AND hidden_src.file_id = ${alias}.file_id
       AND hidden_src.cell_id = ${alias}.cell_id
       AND hidden_src.side = 'source'
       AND COALESCE(hidden_src.target_lang, '') = ''
       AND hidden_src.hidden_at IS NOT NULL
  )`
}
