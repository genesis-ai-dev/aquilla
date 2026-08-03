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
  /** True while the cells-projection fetch is in flight. The WS lifecycle
   *  (syncStatus) is independent of the HTTP cells fetch — on reload the
   *  socket goes `live` long before `fetchAllFileCells` finishes paginating.
   *  Without this we'd flash `ready-empty` for the whole load. */
  cellsLoading: boolean
  /** The authoritative cells read finished unsuccessfully. This is distinct
   * from a successful empty projection and must never render empty-file copy. */
  cellsError: boolean
}

export type CellAreaState =
  | { kind: "no-file" }
  /** Either the WS is still negotiating or the cells fetch is in flight;
   *  cells may arrive any moment — render a skeleton rather than an empty
   *  state. */
  | { kind: "syncing-empty" }
  /** The file may contain cells, but its projection could not be loaded. */
  | { kind: "load-error" }
  /** Sync is settled, cells fetch is done, genuinely no cells. */
  | { kind: "ready-empty" }
  | { kind: "ready" }

export function deriveCellAreaState(input: CellAreaStateInput): CellAreaState {
  if (!input.activeFileId) return { kind: "no-file" }
  if (input.cellCount === 0) {
    if (input.cellsLoading) {
      return { kind: "syncing-empty" }
    }
    if (input.cellsError) return { kind: "load-error" }
    if (input.syncStatus === "connecting") return { kind: "syncing-empty" }
    return { kind: "ready-empty" }
  }
  return { kind: "ready" }
}
