// AQU-2494 (review, Nov 9): a take's volume and fades as ONE player plays it,
// shared by every player that plays a take whole: the line's own play button,
// the takes list and the recording window (useCellAudio), and a text line's
// take playing as the timeline's main player (play-queue's mixLineElement).
// Built by the timeline's own level code (mixer.ts), never a copy of its maths.

import { clipLevelOf, joinedLevelsOf, type ClipLevels } from "./mixer"
import { selectedPieceIds } from "@/lib/sync/cell-audio-read-types"

/** The stored fields a take's level is read from (CodexCellAttachment's). */
export interface LevelledTake {
  gainDb?: number | null
  fadeInMs?: number | null
  fadeOutMs?: number | null
  trimStartMs?: number | null
  trimEndMs?: number | null
  durationMs?: number | null
  pieceOf?: string | null
  slot?: string
  isDeleted?: boolean
  role?: string | null
}

/**
 * A whole take is levelled on its recording's clock. A cut take is levelled
 * piece by piece, each at its OWN volume and fades, where it sits: on the
 * recording's clock, or wherever `on` places a recording second (a joined
 * clip's clock). A piece that holds no level plays as recorded, so a cut made
 * before levels went with a cut (its first piece holding all three) fades out
 * at the cut and plays on as recorded — never silent.
 * Null = it plays as recorded: no level set, or the imported source recording,
 * which the timeline mixes as recorded too.
 */
export function takeLevelsOf(
  attachments: Record<string, LevelledTake> | undefined,
  audioId: string | null | undefined,
  recordingSec: number,
  on: (recordingSec: number) => number = (sec) => sec,
): ClipLevels | null {
  const att = audioId ? attachments?.[audioId] : undefined
  if (!attachments || !att || att.role === "source") return null
  const ids = selectedPieceIds(attachments, audioId)
  if (ids.length <= 1) return clipLevelOf(att)
  const ends = ids.map((id) => {
    const ms = attachments[id].trimEndMs ?? attachments[id].durationMs ?? null
    return ms != null ? ms / 1000 : recordingSec
  })
  // Unmeasured (a cut always has a length): as recorded, as before.
  if (ends.some((e) => !(e > 0))) return null
  let prevEnd = 0
  return joinedLevelsOf(ids.map((id, i) => {
    const start = on((attachments[id].trimStartMs ?? 0) / 1000)
    const end = on(ends[i])
    const gapBeforeSec = start - prevEnd
    prevEnd = end
    return { start, end, gapBeforeSec, att: attachments[id] }
  }))
}
