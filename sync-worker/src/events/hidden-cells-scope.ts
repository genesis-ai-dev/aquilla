// Which cells are HIDDEN, as one SQL predicate. (AQU-1424)
//
// "Hide cell" (AQU-1422) parks a cell without deleting anything: the source
// text, every lane's translation, recordings, comments and validations survive,
// and "Show cell" brings the row back. AQU-1424 is the other half of that
// promise — a parked cell stops being WORK. It leaves progress (numerator AND
// denominator), health, drafting, autopilot, the agent's cell selection and
// search. Otherwise a hidden cell drags completion down forever, Draft-all
// spends credits on text nobody will read, and Find & Replace rewrites words
// the reviewer cannot see.
//
// ONE predicate, quoted here once, because the alternative is the same
// condition written out at a dozen call sites with slightly different ideas of
// where the flag lives. The client's mirror is src/lib/cells/hidden.ts and must
// agree with it. `auth-worker` has no import path into this package, so its
// copy (autopilot tick, agent cell selection and search) is spelled out there
// with a pointer back here.
//
// WHERE THE FLAG LIVES, and why there are TWO forms below. `cells.hidden_at`
// (migration 0112) sits only on the SHARED SOURCE ROW
// (`side = 'source' AND target_lang = ''`), because hiding is per CELL, not per
// lane — it parks the row for every language at once. So:
//
//   * A query already scanning source rows asks the row it has:
//     {@link visibleSourceSql}.
//   * A query that matched a row on EITHER side — search does, and its
//     Find & Replace candidates come straight off those results — has to go
//     LOOK at the source row: {@link notHiddenSql}. Reading `hidden_at` off the
//     matched row would let every target-side hit through, since a target row
//     carries no flag of its own. Worse, a target row created AFTER the hide (a
//     collaborator's in-flight translation, which must survive) is exactly the
//     row that must not come back.
//
// PREREQUISITE: migration 0112 must be applied. Referenced unguarded, following
// the convention every prior column here uses (`lane_id` from AQU-1240 is in
// the hot read path the same way) — the column ships applied, not probed.

/**
 * `<alias>.hidden_at IS NULL` — "this SOURCE row is visible".
 *
 * Always give it the SOURCE alias. Point it at a target row and it reads NULL
 * on every row, so nothing is ever excluded and the bug looks like the feature
 * silently not working. Use {@link notHiddenSql} when the alias may be either
 * side.
 *
 * No COALESCE, unlike `structuralPredicateSql`: `IS NULL` is already null-safe
 * in both its plain and negated forms, so the trap that one documents — a bare
 * `IN (...)` reading NULL under NOT and dropping untyped rows — cannot arise.
 */
export function visibleSourceSql(alias: string): string {
  return `${alias}.hidden_at IS NULL`
}

/**
 * The anti-join form: "the cell this row belongs to is not parked", for a row
 * whose side is unknown or is the target.
 *
 * Correlates on (project, file, cell) and pins `side = 'source'` plus
 * `target_lang = ''` so it reads the one shared row that carries the flag.
 *
 * Cost: the partial index migration 0112 adds
 * (`idx_cells_hidden ... WHERE hidden_at IS NOT NULL`) covers exactly this
 * lookup, so a file with no hidden cells pays an empty index probe.
 */
export function notHiddenSql(alias: string): string {
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

/**
 * The set form: `<cellIdExpr> NOT IN (<this file's hidden cell ids>)`, for a
 * grouped scan that must stay Sort-free.
 *
 * WHY A THIRD FORM RATHER THAN {@link notHiddenSql}. The `files` counter
 * recompute is under a plan-shape guardrail
 * (`sync-worker/src/__tests__/hot-query-plans.test.ts`, migration 0085): its
 * `GROUP BY cell_id` must ride an ordered Index Only Scan on `cells_pkey` with
 * NO Sort node. In prod that query runs over 37K-cell files under
 * `work_mem = 4MB`, and the shape this guards against wrote 4.6 GB of temp
 * across 5K calls.
 *
 * A correlated `NOT EXISTS` breaks that: the planner turns it into a Merge Anti
 * Join and sorts the inner side on `cell_id` — measured, not assumed, and it
 * does so with or without a COALESCE and whatever order the correlation clauses
 * are written in. Collecting the ids ONCE into a hashed subplan keeps the outer
 * scan exactly as it was.
 *
 * Cheap for the same reason the partial index is: hidden cells are a handful per
 * file, so the subplan reads a handful of rows through `idx_cells_hidden` once,
 * not once per group.
 *
 * `NOT IN` IS SAFE HERE, and it is worth saying why, because `NOT IN` against a
 * set containing NULL returns NO ROWS AT ALL — a file would report zero cells.
 * `cell_id` is part of `cells`' primary key, so it can never be NULL, and the
 * subquery selects nothing else. Do not widen this subquery to a nullable
 * column.
 *
 * `cellIdExpr` is whatever resolves in the CALLER's scope, so an unqualified
 * `cell_id` is the right argument when the caller's only FROM relation is
 * `cells`. Prefer that: a `cells.`-qualified column is equally valid SQL but
 * trips the blunt guard in `event-projection.test.ts`, which catches a `cells`
 * column pasted into a statement whose own FROM has no `cells` (AQU-1068 — it
 * broke removal outright) and is worth keeping blunt.
 */
export function visibleCellIdSql(
  cellIdExpr: string,
  projectExpr: string,
  fileExpr: string,
): string {
  return `${cellIdExpr} NOT IN (
    SELECT hidden_src.cell_id FROM cells hidden_src
     WHERE hidden_src.project_id = ${projectExpr}
       AND hidden_src.file_id = ${fileExpr}
       AND hidden_src.side = 'source'
       AND COALESCE(hidden_src.target_lang, '') = ''
       AND hidden_src.hidden_at IS NOT NULL
  )`
}
