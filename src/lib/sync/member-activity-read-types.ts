// Types for the sync-worker per-member activity read API (AQU-498).
//
// Mirror of `sync-worker/src/events/member-activity-read-route.ts`.

/** One recent event authored by the selected member. */
export interface MemberActivityEvent {
  id: string
  /** Event kind, e.g. "target.cell.commit". */
  kind: string
  fileId: string | null
  cellId: string | null
  clientTs: number
  serverTs: number
  serverSeq: number
}

/**
 * Per-file volume + timing rollup for the selected member, derived from the
 * `cells` projection's `last_editor` column — see the route's doc comment for
 * why this is a strict subset of the file's own totals (reconciles by
 * construction, never over-counts).
 */
export interface MemberFileRollup {
  fileId: string
  fileName: string
  cellsTouched: number
  wordCount: number
  lastActivityAt: number | null
}

/** Wire shape of the member-activity endpoint response. */
export interface MemberActivityResponse {
  recentEvents: MemberActivityEvent[]
  fileRollup: MemberFileRollup[]
}
