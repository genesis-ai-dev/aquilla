// Types for the sync-worker link-cursor-batches read API (AQU-478).
//
// Mirror of `sync-worker/src/events/link-cursor-batches-route.ts`.

/** One `source.cell.mirror` / `file.mirror` event that a batch produced. */
export interface LinkCursorBatchEvent {
  id: string
  kind: string
  fileId: string | null
  cellId: string | null
  /** Kind-specific payload — see sync-worker/src/events/types.ts. For
   *  `source.cell.mirror` this carries `{ value, deleted?, upstream: {...} }`. */
  payload: unknown
  serverTs: number
}

/** One mirror-sync batch — corresponds to one `link.cursor.advance` event. */
export interface LinkCursorBatch {
  batchId: string
  upstreamProjectId: string
  fromSeq: number
  toSeq: number
  cellCount: number
  serverTs: number
  /** The mirror events this batch produced, in apply order. */
  events: LinkCursorBatchEvent[]
  /** True if `events` was truncated at the server's per-batch cap. */
  truncated: boolean
}

/** Wire shape of GET /api/v1/projects/:projectId/link/cursor-batches. */
export interface LinkCursorBatchesResponse {
  projectId: string
  batches: LinkCursorBatch[]
}
