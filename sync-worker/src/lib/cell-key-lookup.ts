// Bounded `(file_id, cell_id) IN (…)` lookups (AQU-1983).
//
// Every per-cell read in this worker — the changeset engine's preconditions
// (external/preconditions.ts), the supersession predicate's live state
// (external/supersede-state.ts), link-sync's mirror reads
// (events/link-sync.ts) — keys the cells it wants with a row-constructor IN
// list, two bound values per cell. Those lists grow with the caller's batch (a
// whole-book changeset is 5,000 cells; the first sync of a new link touches
// the upstream's every cell), and two ceilings sit on one statement of that
// shape:
//
//  1. Binds — postgres.js, the driver every worker reaches Postgres through,
//     refuses a statement with more than 65,534 bound values (AQU-1543,
//     AQU-1852): ~32.7k cells in one list and the prepare fails before
//     anything is sent.
//  2. Depth — Postgres rewrites a row-constructor `(a, b) IN ((…), (…), …)`
//     list into a left-deep nested OR tree, one level per row, so every
//     recursive pass over the expression (analysis, rewrite, planning)
//     recurses once per row. Native Postgres absorbs thousands of levels
//     (2 MB max_stack_depth), but PGlite — the worker test database, Postgres
//     in WASM on Node's ~1 MB native stack — overflows between 1,700 and 1,800
//     rows, swallows the overflow, and the next protocol message fails with
//     "unnamed prepared statement does not exist" (AQU-1982). A page past
//     that cannot be tested at all.
//
// So every such read goes through `selectByCellKeys`: one statement per
// CELL_KEY_LOOKUP_ROWS keys, rows concatenated. The reads are independent
// point lookups, so paging cannot change what they return — only how many
// statements it takes.

/** Cell keys per `(file_id, cell_id) IN (…)` statement. 1,000 keys = 2,001
 *  bound values with the project id — well under both ceilings above, and the
 *  same size as the import route's rows-per-INSERT. */
export const CELL_KEY_LOOKUP_ROWS = 1000

export interface CellKey {
  fileId: string
  cellId: string
}

/**
 * Run one `(file_id, cell_id) IN (…)` read over ANY number of cell keys, as a
 * series of bounded statements whose rows are concatenated.
 *
 * `sqlFor` receives the placeholder list for one page (`(?, ?), (?, ?), …`)
 * and returns the full statement; `leadingBinds` are the values bound before
 * the keys (the project id, in every caller). Pages cannot overlap, so no row
 * is returned twice. No keys → no statement.
 */
export async function selectByCellKeys<Row>(
  db: AquillaDb,
  cellKeys: readonly CellKey[],
  leadingBinds: readonly unknown[],
  sqlFor: (placeholders: string) => string,
): Promise<Row[]> {
  const rows: Row[] = []
  for (let i = 0; i < cellKeys.length; i += CELL_KEY_LOOKUP_ROWS) {
    const page = cellKeys.slice(i, i + CELL_KEY_LOOKUP_ROWS)
    const binds: unknown[] = [...leadingBinds]
    for (const k of page) binds.push(k.fileId, k.cellId)
    const { results } = await db
      .prepare(sqlFor(page.map(() => '(?, ?)').join(', ')))
      .bind(...binds)
      .all<Row>()
    for (const r of results) rows.push(r)
  }
  return rows
}
