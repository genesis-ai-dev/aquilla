// Projection-reconciliation pass for the Codex → Aquilla migration CLIs.
//
// Three repairs share one read of the projection's current cells per file:
//
// - Deletion-by-absence (AQU-910): the mapper only ever sees the cells still
//   present in a Codex notebook, so a cell Codex removed from the array
//   outright (hard delete, or a heading/verse merged away) produced no event
//   and survived every re-run. Retract it.
// - Resurrection: the mirror image — a cell LIVE in today's parse whose row a
//   previous run wrongly deleted (a poisoned stale-checkout run mapped an
//   ancient notebook state and retracted current cells). Its create/commits
//   delta-filter on their logged ids, so no re-run can re-materialize it;
//   re-emit the mapper's events for it under escalated deterministic ids.
// - Anchor repair (AQU-931): retractions hard-delete rows that surviving
//   cells' stored `anchor_cell_id` still points at (deterministic creates are
//   INSERT OR IGNOREd, so their payloads never refresh), which scrambles the
//   read order. Re-anchor every migration-created survivor whose stored
//   anchor differs from the anchor today's mapping produced — escalating past
//   a logged-but-undone repair when the divergence is provably damage.
//
// Cheap by construction: a project with no prior migration events has nothing to
// reconcile and skips the reads entirely.

import {
  liveSourceAnchorsByFile,
  mapAnchorRepairs,
  mapCellResurrections,
  mapOrphanRetractions,
  type ProjectionCell,
} from "../../src/lib/migrate/orphans"
import type { IngestEvent } from "../../src/lib/migrate/types"

const CELL_PAGE = 20000

export interface OrphanPassArgs {
  syncBase: string
  secret: string
  projectId: string
  /** The event stream this pass mapped from the current Codex working copy. */
  events: IngestEvent[]
  /** Event ids already in the project's log (the delta-sync read). */
  existingEventIds: ReadonlySet<string>
  fallbackAuthor: string
  fallbackTs: number
}

async function fetchProjectionCells(
  syncBase: string,
  secret: string,
  projectId: string,
  fileId: string,
): Promise<ProjectionCell[]> {
  const out: ProjectionCell[] = []
  let after = ""
  for (;;) {
    const url =
      `${syncBase}/migrate/cell-ids?projectId=${encodeURIComponent(projectId)}`
      + `&fileId=${encodeURIComponent(fileId)}`
      + `&after=${encodeURIComponent(after)}&limit=${CELL_PAGE}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } })
    if (!res.ok) throw new Error(`cell-ids HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const page = (await res.json()) as { cells: ProjectionCell[]; lastCellId: string; more: boolean }
    out.push(...page.cells)
    if (!page.more) break
    after = page.lastCellId
  }
  return out
}

export interface ReconciliationEvents {
  /** AQU-910: cells the projection holds that today's parse no longer produces. */
  retractions: IngestEvent[]
  /** AQU-931: surviving cells whose stored anchor differs from today's chain. */
  repairs: IngestEvent[]
  /** Live cells a previous run wrongly deleted — the mapper's own events for
   *  them re-emitted under escalated ids so they re-materialize. */
  resurrections: IngestEvent[]
}

/**
 * Retractions for every cell the projection still holds that the current Codex
 * parse no longer produces, resurrections for live cells whose rows a previous
 * run wrongly deleted, plus anchor repairs for the cells that survive with a
 * stale chain. Scoped to files this pass produced, and only ever touching
 * cells the migration itself created (see src/lib/migrate/orphans).
 */
export async function computeOrphanRetractions(args: OrphanPassArgs): Promise<ReconciliationEvents> {
  const { syncBase, secret, projectId, events, existingEventIds, fallbackAuthor, fallbackTs } = args
  // Nothing was ever migrated into this project → no orphans are possible, and
  // no create was ever deduped → nothing can need re-anchoring or resurrecting.
  if (existingEventIds.size === 0) return { retractions: [], repairs: [], resurrections: [] }

  const skipEventIds = new Set(events.map((e) => e.id))
  const retractions: IngestEvent[] = []
  const repairs: IngestEvent[] = []
  const resurrections: IngestEvent[] = []
  for (const [fileId, intendedAnchors] of liveSourceAnchorsByFile(events)) {
    const projectionCells = await fetchProjectionCells(syncBase, secret, projectId, fileId)
    if (projectionCells.length === 0) continue
    retractions.push(
      ...mapOrphanRetractions({
        projectId,
        fileId,
        liveCellIds: new Set(intendedAnchors.keys()),
        projectionCells,
        existingEventIds,
        skipEventIds,
        fallbackAuthor,
        fallbackTs,
      }),
    )
    // Resurrections BEFORE repairs: a follower whose intended anchor is being
    // resurrected must escalate its suppressed repair (see mapAnchorRepairs).
    const resurrected = mapCellResurrections({
      fileId,
      events: events.filter((e) => e.fileId === fileId),
      projectionCells,
      existingEventIds,
    })
    resurrections.push(...resurrected.events)
    repairs.push(
      ...mapAnchorRepairs({
        projectId,
        fileId,
        intendedAnchors,
        projectionCells,
        existingEventIds,
        resurrectedCellIds: resurrected.cellIds,
        liveCellIds: new Set(intendedAnchors.keys()),
        fallbackAuthor,
        fallbackTs,
      }),
    )
  }
  return { retractions, repairs, resurrections }
}
