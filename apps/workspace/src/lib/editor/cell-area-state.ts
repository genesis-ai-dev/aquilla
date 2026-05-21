// Pure state machine for the editor cell area. Centralizes the decision of
// "what should we render right now?" so ProjectWorkspace stops eyeballing a
// cluster of booleans (cells.length, syncStatus) and flashing between empty
// and populated while a file loads.
//
// Phase 2c-gamma: the per-file Y.Doc handle is gone. The "still hydrating"
// state collapsed into "fileId set but no cells yet" — which is the same
// shape we used to drive syncing-empty with.
//
// Kept pure (no hook) so the state transitions are trivially testable. The
// consuming component binds it to live signals with useMemo.

import type { SyncStatus } from "@/components/SyncStatusIndicator"

export interface CellAreaStateInput {
  activeFileId: string | null
  cellCount: number
  syncStatus: SyncStatus
}

export type CellAreaState =
  | { kind: "no-file" }
  /** Sync is still negotiating; cells may arrive any moment — render a
   *  skeleton rather than an empty state. */
  | { kind: "syncing-empty" }
  /** Sync is settled (or irrelevant), genuinely no cells. */
  | { kind: "ready-empty" }
  | { kind: "ready" }

export function deriveCellAreaState(input: CellAreaStateInput): CellAreaState {
  if (!input.activeFileId) return { kind: "no-file" }
  if (input.cellCount === 0) {
    if (input.syncStatus === "connecting") return { kind: "syncing-empty" }
    return { kind: "ready-empty" }
  }
  return { kind: "ready" }
}
