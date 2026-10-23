// AQU-2110: which of a file's lines are RECORDED, and which are AUDIO
// VALIDATED, as two id sets the cell store can count per division.
//
// The chapter picker's figures come off the store's navigation rollup, which
// is counted over the cell projection — and audio lives nowhere in it. The
// store already learns which lines carry a take of their own through
// `setOwnTakeCellIds` (AQU-646); this is the same hand-off for the two audio
// figures, so a chapter on an audio-only project can read "100% recorded /
// 100% audio validated" instead of the "100% translated / 0% validated" it
// read while only text validation was ever consulted.
//
// The rules are the server's, restated over the read shape — the same reason
// `selectedDubTakes` exists in one place:
//
//   - RECORDED is a take of this line's OWN, in any slot. The imported source
//     clip is seeded with the FILE's id and sits selected on every cell of a
//     media file, so only a cell-seeded take counts; otherwise one attached
//     programme audio would report a whole subtitle file as fully recorded.
//     This is exactly the membership test `ownTakeCellIds` applies, so the
//     picker's "recorded" can never disagree with the "translated" the same
//     take earned the line before this change.
//   - AUDIO VALIDATED is the WEAKEST chosen take meeting the project's audio
//     requirement — `cellAudioVotes` is that minimum, and `isTakeValidated` is
//     the one comparison every audio surface draws "validated" by. A line that
//     is not recorded can never be validated, so the second set is a subset
//     of the first by construction, never by coincidence.
//   - The structural-cell policy is NOT applied here: the store's rollup
//     already skips a heading for every figure it counts, so these sets stay
//     plain membership and the policy has one owner.
//
// Pure, so the store's tests can drive it with hand-built entries and the
// workspace can memoize it on the attachment map alone.
import { audioIdSeededWith } from "../../../db/shared/audio-id"
import {
  cellAudioVotes,
  isTakeValidated,
  slotSelections,
  type CellAudioEntry,
} from "@/lib/sync/cell-audio-read-types"

export interface AudioProgressCellIds {
  /** Lines carrying a take of their own, in any slot. */
  recorded: ReadonlySet<string>
  /** Lines whose every chosen take meets the audio validation requirement. Always ⊆ `recorded`. */
  audioValidated: ReadonlySet<string>
}

const EMPTY_IDS: ReadonlySet<string> = new Set()

/** What the store holds before the attachment map lands: nothing recorded. */
export const EMPTY_AUDIO_PROGRESS_CELL_IDS: AudioProgressCellIds = Object.freeze({
  recorded: EMPTY_IDS,
  audioValidated: EMPTY_IDS,
})

/** Does this line carry a take of its OWN, in any slot? */
export function cellHasOwnTake(cellId: string, entry: CellAudioEntry | undefined): boolean {
  if (!entry) return false
  for (const selected of Object.values(slotSelections(entry))) {
    if (selected && audioIdSeededWith(selected, cellId)) return true
  }
  return false
}

/**
 * The two id sets, derived from one file's attachment map at
 * `audioValidationRequirement` (the project's audio requirement, already
 * resolved project → org → 1 by `readValidationCountAudio`).
 */
export function audioProgressCellIds(
  audioByCellId: ReadonlyMap<string, CellAudioEntry>,
  audioValidationRequirement: number,
): AudioProgressCellIds {
  const recorded = new Set<string>()
  const audioValidated = new Set<string>()
  for (const [cellId, entry] of audioByCellId) {
    if (!cellHasOwnTake(cellId, entry)) continue
    recorded.add(cellId)
    const votes = cellAudioVotes(entry)
    if (votes != null && isTakeValidated({ validatorCount: votes }, audioValidationRequirement)) {
      audioValidated.add(cellId)
    }
  }
  if (recorded.size === 0) return EMPTY_AUDIO_PROGRESS_CELL_IDS
  return { recorded, audioValidated }
}

/** Same members in both sets? Identity first, so the no-change case costs nothing. */
export function sameAudioProgressCellIds(a: AudioProgressCellIds, b: AudioProgressCellIds): boolean {
  if (a === b) return true
  return sameSet(a.recorded, b.recorded) && sameSet(a.audioValidated, b.audioValidated)
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}
