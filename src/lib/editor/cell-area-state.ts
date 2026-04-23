// Pure state machine for the editor cell area. Centralizes the decision of
// "what should we render right now?" so ProjectWorkspace stops eyeballing a
// cluster of booleans (docLoading, doc, cells.length, syncStatus) and flash-
// ing between empty and populated while a file hydrates.
//
// Kept pure (no hook) so the state transitions are trivially testable. The
// consuming component binds it to live signals with useMemo.

import type { SyncStatus } from "@/components/SyncStatusIndicator"

export interface CellAreaStateInput {
  activeFileId: string | null
  docLoading: boolean
  hasDoc: boolean
  cellCount: number
  syncStatus: SyncStatus
}

export type CellAreaState =
  | { kind: "no-file" }
  | { kind: "loading" }
  /** Doc is in memory but sync is still negotiating. We expect cells to
   *  arrive any moment — render a skeleton rather than an empty state so
   *  we don't flash "No cells" → populated. */
  | { kind: "syncing-empty" }
  /** Doc is in memory, sync is settled (or irrelevant), genuinely no cells. */
  | { kind: "ready-empty" }
  | { kind: "ready" }

export function deriveCellAreaState(input: CellAreaStateInput): CellAreaState {
  if (!input.activeFileId) return { kind: "no-file" }
  if (input.docLoading || !input.hasDoc) return { kind: "loading" }
  if (input.cellCount === 0) {
    if (input.syncStatus === "connecting") return { kind: "syncing-empty" }
    return { kind: "ready-empty" }
  }
  return { kind: "ready" }
}
