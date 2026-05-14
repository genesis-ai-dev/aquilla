// Types for the sync-worker read API (server-side reads, AD-3 v1 thin client).
//
// Mirror of the server's response shapes in:
//   sync-worker/src/events/files-read-route.ts
//   sync-worker/src/events/cells-read-route.ts
//
// These will move into `packages/data-model` in Phase 3 (one canonical
// definition shared by every Worker + the web client). Until then we keep
// them local — Phase 2's hook migration only depends on the surface
// described here, not on its physical location.

/**
 * File-level rollup row, as returned by GET /api/v1/projects/:projectId/files.
 * `cellCount` / `approvedCount` / `wordCount` / `lastEditAt` are projected
 * from the cell.commit event stream (see writeProjection on the server).
 */
export interface FileSummary {
  fileId: string
  projectId: string
  name: string
  /** e.g. "codex", "source", "vtt". Matches the FileType enum on the client. */
  fileType: string
  sourceLanguage: string | null
  targetLanguage: string | null
  cellCount: number
  approvedCount: number
  wordCount: number
  /** Last cell.commit timestamp on this file. Null on freshly-created files. */
  lastEditAt: number | null
}

/**
 * One cell row from GET /api/v1/projects/:projectId/files/:fileId/cells.
 * Paired source/target cells share a `cellId`; the `side` field distinguishes
 * them. Anchor-chain order is computed server-side, so consumers can render
 * the array as-is. See AD-9 in spec 02-foundations.md for the dual-side model.
 */
export interface CellRow {
  cellId: string
  side: "source" | "target"
  value: string
  /** Rich-text variant. Null for plain-text cells. */
  valueHtml: string | null
  type: string | null
  canonicalRef: string | null
  anchorCellId: string | null
  /** AD-2 chain head: id of the most recent winning event on this row. */
  eventId: string
  /** AD-9 staleness pin: the source cell's event_id observed at commit time.
   *  Only populated for target-side rows that have been committed against a
   *  source. Null on source-side rows and target-owned cells. */
  sourceEventId: string | null
  lastEditor: string | null
  lastEditAt: number
  validated: boolean
  wordCount: number
}

/** Pagination response shape. */
export interface CellsPage {
  cells: CellRow[]
  /** Opaque cursor for the next page. Null when no more rows exist. */
  nextCursor: string | null
  /** Total chain-walked rows for this query (across all pages). */
  total: number
}
