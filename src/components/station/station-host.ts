// What the Station needs from the workspace (AQU-2327). The workspace owns
// every write — the same trim, vote and history paths the timeline uses — so
// the Station never grows a second way to change a take.

import type { CellData } from "@/hooks/useCells"
import type { SyncTokenFetcher } from "@/lib/audio/peaks-loader"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { HistoryResult } from "@/lib/history/history"
import type { ProjectRecord } from "@/lib/parsers/types"

export interface StationTake {
  /** The file that holds the take (a cue sibling for a linked take). */
  fileId: string
  cell: CellData
  att: CodexCellAttachment
}

export interface StationHost {
  project: ProjectRecord
  username: string
  /** May this person change takes here (the trim event's own role rule)? */
  editable: boolean
  getSyncToken: SyncTokenFetcher
  /** The take as it reads now, through the workspace's own resolver. */
  readTake(cellId: string, audioId: string): StationTake | null
  /** How a line is named: "line 331", or a verse reference. */
  lineName(cellId: string): string
  /** The take's track colours (take-colors.ts). */
  trackVars(fileId: string, slot: string | undefined): Record<string, string>
  /** Whether you may approve this take, and whether you have. */
  voteState(cellId: string, audioId: string): { canVote: boolean; voted: boolean }
  vote(cellId: string, audioId: string, validated: boolean): Promise<void>
  /** Trim, recorded as one Undo step (the timeline's own edge-drag path). */
  trim(cellId: string, audioId: string, trims: { trimStartMs?: number; trimEndMs?: number }): Promise<void>
  /** How many approvals a recording needs in this project. */
  approvalsNeeded: number
  /** Stop the timeline and any other player before the Station plays. */
  pauseOtherPlayback(): void
  /** Say what Undo did, as the top bar's History does. */
  reportHistory(which: "undo" | "redo", result: HistoryResult): void
}
