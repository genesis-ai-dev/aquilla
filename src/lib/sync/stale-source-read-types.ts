// Types for the sync-worker stale-source read API (Phase 5 / AD-9; extended
// FRO-476 §6 — live source links mirror engine + deterministic staleness).
//
// Mirror of `sync-worker/src/events/stale-source-route.ts`.

/**
 * One cell id whose source-side `event_id` no longer matches the target
 * row's pinned `source_event_id`. The list is order-irrelevant; the UI
 * uses it as a membership set keyed by cell id.
 */
export type StaleCellId = string

/** Link-level "you have unmirrored upstream changes" probe (FRO-476 §6).
 *  Non-null iff the project is a `live` link AND the upstream has
 *  lane-relevant changes past the mirrored cursor — comments/audio/
 *  validation-only upstream activity never counts. */
export interface BehindSeq {
  /** Max lane-relevant upstream server_seq. */
  upstream: number
  /** This project's mirrored cursor (`projects.source_link_cursor`). */
  cursor: number
}

/** Response shape returned by GET /:projectId/files/:fileId/stale-source. */
export interface StaleSourceResponse {
  /** The project the query ran against. Echoed for client-side sanity checks. */
  projectId: string
  /** The file the query ran against. */
  fileId: string
  /** The cell ids whose source has advanced since the translator committed. */
  staleCellIds: StaleCellId[]
  /**
   * FRO-476: cell ids whose upstream source was deleted. The downstream's
   * local source row is kept (never deleted) so the orphaned target stays
   * visible — the review UI surfaces these separately from "changed."
   */
  tombstonedCellIds: StaleCellId[]
  /**
   * The upstream project id used for the join, or null when the project
   * is self-contained (in which case the join is against the project's
   * own source side and only meaningful if a `target.cell.commit` was
   * recorded before a subsequent `source.cell.commit` — rare, but legal).
   */
  upstreamProjectId: string | null
  /**
   * FRO-476: link-level "you have unmirrored changes" probe. Null for
   * clone-mode links (which never show upstream drift), self-contained
   * projects, or when the live link has nothing unmirrored.
   */
  behindSeq: BehindSeq | null
}
