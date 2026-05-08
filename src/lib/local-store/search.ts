/**
 * FTS5-backed search over the local cells projection.
 * See docs/DATA_PERSISTENCE_PLAN.md §4.4 — `cells_fts` virtual table.
 */

import type { LocalStore } from "./db"
import type { CellRow } from "./cells"

export interface SearchOptions {
  /** FTS5 MATCH query string. */
  query: string
  /** Restrict matches to a single project. */
  projectId?: string
  /** Max rows returned. */
  limit?: number
}

export async function searchCells(
  store: LocalStore,
  opts: SearchOptions,
): Promise<CellRow[]> {
  const { query, projectId, limit = 50 } = opts
  if (projectId !== undefined) {
    return store.query<CellRow>(
      `SELECT cells.* FROM cells
       JOIN cells_fts ON cells.rowid = cells_fts.rowid
       WHERE cells_fts MATCH ? AND cells.project_id = ?
       LIMIT ?`,
      [query, projectId, limit],
    )
  }
  return store.query<CellRow>(
    `SELECT cells.* FROM cells
     JOIN cells_fts ON cells.rowid = cells_fts.rowid
     WHERE cells_fts MATCH ?
     LIMIT ?`,
    [query, limit],
  )
}
