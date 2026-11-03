// AQU-1758 (Sam, Oct 29): a book's line as playback lays it out, for an export
// that joins a book's takes end to end.
//
// On a book (a file with no times), a pause someone dragged open — before a
// verse's take, or between two pieces of a cut take — plays as silence in the
// app: the take starts that far into its line, and the pieces sit where they
// were placed. An export that joins the takes end to end and left those out
// would not sound like playback, and one that took only a cut take's first
// piece would lose the rest of it. So the exports ask the same layout the
// transport plays (`buildProgramme`, following the recordings) for each line:
// the silence before the take, then each piece, with the silence between them.
//
// Null, and the export carries the take as it always did, when the line has
// times (a timed file's exports are not a book's), when the take's length is
// not known (there is no honest layout), or when the export ships a different
// take from the one playback plays.

import type { CellData } from "@/hooks/useCells"
import { hasTiming } from "@/lib/timeline/derive"
import { buildProgramme } from "@/lib/timeline/programme"
import { MIN_TARGET_LEN_SEC } from "@/lib/timeline/lane-timing"
import { resolveTargetPieces } from "@/lib/audio/track-audio"

export type BookLinePart =
  /** Silence someone dragged open, in ms. */
  | { kind: "silence"; ms: number }
  /** A take, or one piece of a cut take: the attachment, with its own trims. */
  | { kind: "take"; attachmentId: string }

/** Silence shorter than this is rounding, not a pause (one sample at 48 kHz). */
const MIN_SILENCE_MS = 0.02

function silence(sec: number | undefined): BookLinePart[] {
  const ms = Math.round((sec ?? 0) * 100000) / 100
  return ms >= MIN_SILENCE_MS ? [{ kind: "silence", ms }] : []
}

/** The line `cell`, whose export ships `takeId`, as playback lays it out. */
export function bookLineParts(cell: CellData, takeId: string): BookLinePart[] | null {
  if (hasTiming(cell)) return null
  // The take playback plays — the programme lays out the same one.
  if (resolveTargetPieces(cell)[0]?.audioId !== takeId) return null
  // One line on its own: on a book, a line's layout does not depend on the
  // lines around it (each is measured from its own start).
  const slot = buildProgramme([cell], { standInLenSec: () => MIN_TARGET_LEN_SEC }).slots[0]
  if (!slot?.targetWindow) return null
  const pieces = slot.targetPieces ?? [{ audioId: takeId }]
  return [
    ...silence(slot.targetLeadSec),
    ...pieces.flatMap((p): BookLinePart[] => [
      ...silence("gapBeforeSec" in p ? p.gapBeforeSec : undefined),
      { kind: "take", attachmentId: p.audioId },
    ]),
  ]
}
