// Cells / Files read-API types — the canonical shape every consumer of the
// sync-worker projection reads from. Mirrors the response shapes in
// `apps/sync/src/events/files-read-route.ts` and `cells-read-route.ts`.
//
// AD-2: every cell row carries `eventId` — the chain head id.
// AD-9: target rows carry `sourceEventId` — the staleness pin onto the
//       source row's eventId as observed at commit time.

export type CellSide = "source" | "target"

/**
 * File-level rollup row from GET /api/v1/projects/:projectId/files.
 * Counters are projected from the cell.commit event stream.
 */
export interface FileSummary {
  fileId: string
  projectId: string
  name: string
  /** e.g. "codex", "source", "vtt". Matches FileType on the client. */
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
 *
 * Paired source/target cells share `cellId`; the `side` field distinguishes
 * them. Anchor-chain order is computed server-side, so consumers render the
 * array as-is.
 */
export interface CellRow {
  cellId: string
  side: CellSide
  value: string
  /** Rich-text variant. Null for plain-text cells. */
  valueHtml: string | null
  type: string | null
  canonicalRef: string | null
  /** Ordering anchor — id of the cell this row sits after. Null on the first cell. */
  anchorCellId: string | null
  /** AD-2 chain head: id of the most recent winning event on this row. */
  eventId: string
  /**
   * AD-9 staleness pin — the source cell's eventId observed at commit time.
   * Only populated for target-side rows that have been committed against a
   * source. Null on source-side rows and on target-owned cells.
   */
  sourceEventId: string | null
  lastEditor: string | null
  lastEditAt: number
  validated: boolean
  endorsementCount: number
  wordCount: number
}

/** Pagination response wrapper. */
export interface CellsPage {
  cells: CellRow[]
  /** Opaque cursor for the next page. Null when no more rows exist. */
  nextCursor: string | null
  /** Total chain-walked rows for this query (across all pages). */
  total: number
}

/**
 * Per-cell event history entry, from
 * GET /api/v1/projects/:p/files/:f/cells/:c/history.
 * Walks the AD-2 parent chain newest-first. Capped at ~200 entries by the
 * server.
 */
export interface CellHistoryEntry {
  id: string
  parentId: string | null
  kind: string
  author: string
  serverTs: number
  clientTs: number
  payload: Record<string, unknown>
  schemaVersion: number
}
