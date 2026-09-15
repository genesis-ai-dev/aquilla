// Lands the author's own write from the `POST /events` response.
//
// Before this module a commit cost three requests: the POST, then — after the
// outbox flush resolved — GET …/cells?cellIds= (row head) and
// GET /cells/audit-stats?cellId= (stats row). The server now returns the
// same `event.applied`-shaped frames it broadcasts to peers (`applied[]`),
// so the committing tab applies them through the existing `liveApplier`
// path and derives the stats entry from the projected row. The handler then
// asks `confirm()` whether either GET is still needed: only when the server
// did not carry the frame (older worker, >cap request, partial commit) or
// the event is a kind whose stats cannot be derived (validate/unvalidate).

import type { AppliedEventFrame, LiveApplier } from "./live-apply"
import type { CellRow } from "./cells-read-types"

/** Kinds whose audit-stats entry is fully implied by the projected row:
 *  `lastEditEventId` = the row's head, validators reset with the head, and
 *  waivers are untouched by a content commit. Validation events change
 *  `cell_validators` (not carried on the row) and keep hitting the GET. */
export function isStatsDerivableKind(kind: string): boolean {
  return (
    kind === "target.cell.commit" ||
    kind === "target.cell.create" ||
    kind === "source.cell.commit" ||
    kind === "source.cell.create"
  )
}

export interface FlushAppliedTracker {
  /** Feed every `applied[]` frame a flush returned. Frames for other
   *  projects/files are ignored (their store isn't mounted). */
  onFrames(frames: AppliedEventFrame[]): void
  /**
   * Called by the committing handler after its flush resolved. Reports which
   * post-flush refetches are still required for `cellId` and forgets the
   * cell's entry. `eventId`, when the caller knows it, must match the frame
   * the server applied — a mismatch (e.g. an older event's frame) falls back
   * to both GETs.
   */
  confirm(cellId: string, eventId?: string): { refetchCell: boolean; refetchStats: boolean }
  /** Forget everything — call on file switch. */
  reset(): void
}

export function createFlushAppliedTracker(opts: {
  liveApplier: LiveApplier
  /** Is this frame's (project, file) the mounted store? */
  isActive(projectId: string, fileId: string): boolean
  /** Merge a derived stats entry for a committed cell. Return false when the
   *  hook could not (disabled / file mismatch) so the GET stays. */
  applyCommittedCellStats(cellId: string, rows: CellRow[]): boolean
}): FlushAppliedTracker {
  const landed = new Map<string, { eventId: string; statsDerived: boolean }>()
  return {
    onFrames(frames) {
      for (const frame of frames) {
        if (!frame.cell || !frame.file || !opts.isActive(frame.project, frame.file)) continue
        const result = opts.liveApplier.apply(frame)
        if (result !== "applied") {
          // "refetch": liveApplier already kicked revalidateCell; "ignored":
          // the store holds a newer projection. Either way nothing landed
          // for THIS event, so confirm() must keep the fallback GETs.
          landed.delete(frame.cell)
          continue
        }
        const statsDerived =
          isStatsDerivableKind(frame.kind) &&
          opts.applyCommittedCellStats(frame.cell, frame.rows as CellRow[])
        landed.set(frame.cell, { eventId: frame.id, statsDerived })
      }
    },
    confirm(cellId, eventId) {
      const entry = landed.get(cellId)
      landed.delete(cellId)
      if (!entry || (eventId !== undefined && entry.eventId !== eventId)) {
        return { refetchCell: true, refetchStats: true }
      }
      return { refetchCell: false, refetchStats: !entry.statsDerived }
    },
    reset() {
      landed.clear()
    },
  }
}
