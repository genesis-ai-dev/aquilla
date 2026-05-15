// Types for the sync-worker per-cell history read API (Phase 2b).
//
// Mirror of `apps/sync/src/events/cell-history-read-route.ts`.
// Move to `packages/data-model` in Phase 3.

/**
 * One event from a cell's history chain. Returned by
 * GET /api/v1/projects/:projectId/files/:fileId/cells/:cellId/history.
 *
 * Newest events come first. `parentId` is the previous winning event id
 * on this cell's chain (null only for genesis events — `source.cell.create`
 * or `target.cell.create`). See AD-2 in spec 02-foundations.md.
 */
export interface CellHistoryEvent {
  id: string
  parentId: string | null
  /** Event kind. Prefixed by `source.` (importer) or `target.` (translator). */
  kind: string
  /** User id (or admin id for system-emitted events) that authored this event. */
  author: string
  clientTs: number
  serverTs: number
  serverSeq: number
  /** Kind-specific JSON payload — see 03-data-model.md "Event Kinds". */
  payload: unknown
}

/** Wire shape of the history endpoint response. */
export interface CellHistoryResponse {
  events: CellHistoryEvent[]
}
