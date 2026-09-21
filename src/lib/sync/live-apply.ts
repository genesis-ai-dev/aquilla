// Live apply of `event.applied` frames that carry the cell's projected rows.
//
// Before this module, every remote `event.applied` cost a round trip:
// frame → revalidateCell(cell) → GET …/cells?cellIds= → replaceRowsForCell.
// Sync-worker now (optionally, additively) puts the cell's CURRENT projected
// rows and the event's `server_seq` on the frame, serialised by the same
// function the GET uses. When both are present we can land them in the store
// directly and skip the fetch; when either is missing we fall back to the
// refetch exactly as before. The orchestrator wires `apply()` into
// ProjectWorkspace's event.applied handler in place of the bare
// `revalidateCell(msg.cell)` call.

import type { CellRow } from "./cells-read-types"
import type { ProjectWsServerMessage } from "./ws-reconciler"

export type AppliedEventFrame = Extract<ProjectWsServerMessage, { t: "event.applied" }>

/** The slice of CellStore's public API this module needs — the same four
 *  calls `revalidateCell` in useActiveCellStore.ts makes after its GET. */
export interface LiveApplyStore {
  getWriteSeq(): number
  clearConfirmedShadows(serverRows: CellRow[], fetchStartSeq: number): void
  markCellFresh(cellId: string): void
  replaceRowsForCell(cellId: string, rows: CellRow[]): void
}

export type LiveApplyDecision = "apply" | "refetch" | "ignore"
export type LiveApplyResult = "applied" | "refetch" | "ignored"

export interface LiveApplier {
  apply(frame: AppliedEventFrame): LiveApplyResult
  /** Forget per-cell ordering state — call on file switch. */
  reset(): void
}

/**
 * Pure ordering/eligibility decision for one frame.
 * - no `cell`, `rows`, or `serverSeq` → "refetch" (legacy frame; caller fetches)
 * - `serverSeq` older than the last one applied to this cell → "ignore"
 *   (a late frame; the store already holds a newer projection)
 * - otherwise → "apply" (equal seq re-applies the same rows: harmless)
 */
export function shouldApplyFrame(
  frame: Pick<AppliedEventFrame, "cell" | "rows" | "serverSeq">,
  lastSeq: number | undefined,
): LiveApplyDecision {
  if (!frame.cell || !frame.rows || typeof frame.serverSeq !== "number") return "refetch"
  if (lastSeq !== undefined && frame.serverSeq < lastSeq) return "ignore"
  return "apply"
}

export function createLiveApplier(opts: {
  store: LiveApplyStore
  revalidateCell: (cellId: string) => void
}): LiveApplier {
  const { store, revalidateCell } = opts
  const lastSeqByCell = new Map<string, number>()
  return {
    apply(frame) {
      const cell = frame.cell
      if (!cell) return "refetch"
      const decision = shouldApplyFrame(frame, lastSeqByCell.get(cell))
      if (decision === "ignore") return "ignored"
      if (decision === "refetch") {
        revalidateCell(cell)
        return "refetch"
      }
      // `decision === "apply"` guarantees these are present.
      const rows = frame.rows as CellRow[]
      const serverSeq = frame.serverSeq as number
      // Same sequence as revalidateCell's post-GET landing. Rows are truth
      // regardless of `by` — an own-write echo or a cross-tab write applies
      // just like a remote one.
      //
      // Optimistic safety: if the user has a NEWER local edit in flight for
      // this cell (an optimistic shadow whose value differs from the incoming
      // target row), we still replace the rows. clearConfirmedShadows only
      // drops a shadow on value equality, so the surviving shadow keeps
      // painting the local value through applyContentOverlays until its own
      // commit echoes back and confirms it.
      const startSeq = store.getWriteSeq()
      store.clearConfirmedShadows(rows, startSeq)
      store.markCellFresh(cell)
      store.replaceRowsForCell(cell, rows)
      lastSeqByCell.set(cell, serverSeq)
      return "applied"
    },
    reset() {
      lastSeqByCell.clear()
    },
  }
}
