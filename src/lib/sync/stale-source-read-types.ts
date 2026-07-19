// Types for the sync-worker stale-source read API (Phase 5 / AD-9; extended
// AQU-476 §6 — live source links mirror engine + deterministic staleness).
//
// Mirror of `sync-worker/src/events/stale-source-route.ts`.

/**
 * One cell id whose source-side `event_id` no longer matches the target
 * row's pinned `source_event_id`. The list is order-irrelevant; the UI
 * uses it as a membership set keyed by cell id.
 */
export type StaleCellId = string

/** Link-level "you have unmirrored upstream changes" probe (AQU-476 §6).
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
   * AQU-476: cell ids whose upstream source was deleted. The downstream's
   * local source row is kept (never deleted) so the orphaned target stays
   * visible — the review UI surfaces these separately from "changed."
   */
  tombstonedCellIds: StaleCellId[]
  /**
   * AQU-477: cell ids whose ANCESTRY is stale (design spec §6's per-hop
   * chain walk) — an ancestor hop above the immediate upstream changed, or
   * the immediate upstream's own translation is itself stale against its
   * source (the "dormant middle hop" case: English fixed, French never
   * re-synced, Chaluba must still flag). Distinct from `staleCellIds`
   * (direct, single-hop) — the UI renders a second, visually distinct tone
   * for this set (violet/hollow vs. amber) so a translator can tell "my
   * immediate source changed" from "something further upstream changed."
   * A cell can appear in only one of the two sets at a time in the common
   * case, but the UI should not assume disjointness.
   */
  upstreamStaleCellIds: StaleCellId[]
  /**
   * The upstream project id used for the join, or null when the project
   * is self-contained (in which case the join is against the project's
   * own source side and only meaningful if a `target.cell.commit` was
   * recorded before a subsequent `source.cell.commit` — rare, but legal).
   */
  upstreamProjectId: string | null
  /**
   * AQU-476: link-level "you have unmirrored changes" probe. Null for
   * clone-mode links (which never show upstream drift), self-contained
   * projects, or when the live link has nothing unmirrored.
   */
  behindSeq: BehindSeq | null
  /**
   * AQU-477: true iff some ancestor further up the chain (beyond the
   * immediate upstream) is itself behind ITS upstream. Link-granularity
   * only (§6 step 3 / §15 — v1 does not attempt per-cell precision for
   * this case); surfaced as a banner-level signal, not a per-cell flag.
   */
  ancestorBehind: boolean
}
