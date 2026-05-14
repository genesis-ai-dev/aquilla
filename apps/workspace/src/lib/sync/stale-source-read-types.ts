// Types for the sync-worker stale-source read API (Phase 5 / AD-9).
//
// Mirror of `sync-worker/src/events/stale-source-route.ts`.

/**
 * One cell id whose source-side `event_id` no longer matches the target
 * row's pinned `source_event_id`. The list is order-irrelevant; the UI
 * uses it as a membership set keyed by cell id.
 */
export type StaleCellId = string

/** Response shape returned by GET /:projectId/files/:fileId/stale-source. */
export interface StaleSourceResponse {
  /** The project the query ran against. Echoed for client-side sanity checks. */
  projectId: string
  /** The file the query ran against. */
  fileId: string
  /** The cell ids whose source has advanced since the translator committed. */
  staleCellIds: StaleCellId[]
  /**
   * The upstream project id used for the join, or null when the project
   * is self-contained (in which case the join is against the project's
   * own source side and only meaningful if a `target.cell.commit` was
   * recorded before a subsequent `source.cell.commit` — rare, but legal).
   */
  upstreamProjectId: string | null
}
