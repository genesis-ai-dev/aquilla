// Deletion-by-absence pass for the Codex → Aquilla migration CLIs (AQU-910).
//
// The mapper only ever sees the cells still present in a Codex notebook, so a
// cell Codex removed from the array outright (hard delete, or a heading/verse
// merged away) produced no event and survived every re-run. This reads the
// projection's current cells for each file the pass produced and asks
// src/lib/migrate/orphans for the retractions.
//
// Cheap by construction: a project with no prior migration events has nothing to
// reconcile and skips the reads entirely.

import { liveCellIdsByFile, mapOrphanRetractions, type ProjectionCell } from "../../src/lib/migrate/orphans"
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

/**
 * Retractions for every cell the projection still holds that the current Codex
 * parse no longer produces. Scoped to files this pass produced, and only ever
 * removing cells the migration itself created (see src/lib/migrate/orphans).
 */
export async function computeOrphanRetractions(args: OrphanPassArgs): Promise<IngestEvent[]> {
  const { syncBase, secret, projectId, events, existingEventIds, fallbackAuthor, fallbackTs } = args
  // Nothing was ever migrated into this project → no orphans are possible.
  if (existingEventIds.size === 0) return []

  const skipEventIds = new Set(events.map((e) => e.id))
  const retractions: IngestEvent[] = []
  for (const [fileId, liveCellIds] of liveCellIdsByFile(events)) {
    const projectionCells = await fetchProjectionCells(syncBase, secret, projectId, fileId)
    if (projectionCells.length === 0) continue
    retractions.push(
      ...mapOrphanRetractions({
        projectId,
        fileId,
        liveCellIds,
        projectionCells,
        existingEventIds,
        skipEventIds,
        fallbackAuthor,
        fallbackTs,
      }),
    )
  }
  return retractions
}
