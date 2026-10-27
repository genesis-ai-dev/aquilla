// AQU-2111: the open file's audio figures, counted in memory.
//
// Every OTHER file's row reads its audio off the project's file list, which
// the sync-worker now answers with the pair (AQU-2111 on `files-read-route`).
// The open file cannot wait for that: its row and the editor footer show a
// live count so a vote moves the bar without a reload, and that live count is
// derived from cells, which carry no audio. So the same two numbers are
// counted here from the attachment map the workspace already reads for bulk
// audio validation.
//
// The rules are the server's, restated over the read shape — the same reason
// `selectedDubTakes` exists in one place:
//
//   - RECORDED is a take of this line's OWN. The imported source clip is
//     seeded with the FILE's id and shared across every cell, so only a
//     cell-seeded take counts; otherwise one attached programme audio would
//     report a whole subtitle file as fully recorded.
//   - VALIDATED is the WEAKEST chosen take meeting the project's audio
//     requirement (`cellAudioVotes` is that minimum), and a line that is not
//     recorded can never be validated.
//   - The structural-cell policy subtracts from BOTH halves, as it does for
//     text: a voiced chapter heading must not count as work when the policy
//     says nobody has to do it.
// Straight from the shared module `@/lib/audio/upload` re-exports it from, so
// this pure counter does not pull the upload path (and its dynamic multipart
// import) into every surface that draws a progress bar.
import { audioIdSeededWith } from "../../../db/shared/audio-id"
import {
  cellAudioVotes,
  isTakeValidated,
  slotSelections,
  type CellAudioEntry,
} from "@/lib/sync/cell-audio-read-types"
import { isStructuralCell } from "@/lib/cells/structural"

/** Just enough of a cell to count it: who it is, and whether it is structure. */
export interface AudioProgressCell {
  id: string
  type?: string | null
}

export interface LiveAudioCounts {
  recorded: number
  audioValidated: number
}

/** Does this line carry a take of its OWN, in any slot? */
export function cellHasOwnTake(cellId: string, entry: CellAudioEntry | undefined): boolean {
  if (!entry) return false
  for (const selected of Object.values(slotSelections(entry))) {
    if (selected && audioIdSeededWith(selected, cellId)) return true
  }
  return false
}

/**
 * The open file's `{ recorded, audioValidated }`, over the cells it holds.
 *
 * Returns null when the attachment map has not loaded, because zero and
 * "not known yet" are different claims and only the caller can tell which one
 * its surface may draw — a fabricated 0 is exactly the "0% recorded" this
 * issue is about.
 */
export function liveAudioProgress(
  cells: readonly AudioProgressCell[],
  audioByCellId: ReadonlyMap<string, CellAudioEntry> | null,
  audioValidationRequirement: number,
  countStructural: boolean,
): LiveAudioCounts | null {
  if (!audioByCellId) return null
  let recorded = 0
  let audioValidated = 0
  for (const cell of cells) {
    if (!countStructural && isStructuralCell(cell.type)) continue
    const entry = audioByCellId.get(cell.id)
    if (!cellHasOwnTake(cell.id, entry) || !entry) continue
    recorded += 1
    const votes = cellAudioVotes(entry)
    if (votes != null && isTakeValidated({ validatorCount: votes }, audioValidationRequirement)) {
      audioValidated += 1
    }
  }
  return { recorded, audioValidated }
}
