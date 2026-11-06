// AQU-1619: ONE way to run ASR on a line's selected take.
//
// The Recording tab's Transcribe button owned this sequence — resolve the ASR
// language by provenance, run `transcribeCell`, flush, poke the owner's
// attachment read — and it was the only surface that could start or re-start a
// transcription. Putting the failure on the source/target row (this issue) gave
// that row a Retry, and a second copy of the rule would have been the third:
// `batch-audio.ts` already carries its own variant for a run whose languages
// are resolved once, for every row.
//
// The rule itself: the ASR language follows the AUDIO, not the row. An imported
// media segment is SOURCE speech (the programme clip, shared by the file's
// rows); every take voices the TARGET text. `isSourceSegmentSelected` is what
// tells them apart.

import { transcribeCell, type TranscribeCellArgs } from "./transcribe"
import { isSourceSegmentSelected } from "./batch-audio"
import { notifyAudioAttachmentsChanged } from "./audio-attachments-bus"
import { laneLanguageForTag } from "@/lib/lanes/lane-language"
import { laneLanguage } from "@/lib/lanes/lane-display"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"

/**
 * The language to recognise this cell's selected clip in: the source lane's
 * for an imported media segment, otherwise the lane being worked in.
 *
 * `undefined` means "let the transcriber decide" — the same thing the Recording
 * tab passed when no lane row resolved.
 */
export function asrLanguageForTake(
  owner: CellData,
  lanes: ProjectRecord["lanes"],
  targetLang: string | undefined,
): string | undefined {
  if (isSourceSegmentSelected(owner)) {
    const sourceLane = lanes?.find((lane) => lane.role === "source")
    return laneLanguage(sourceLane ?? { role: "source" }, {
      role: "source",
      legacyTag: sourceLane?.legacyTag ?? null,
    })
  }
  return laneLanguageForTag(targetLang ?? "", lanes) ?? undefined
}

export interface TranscribeTakeArgs {
  project: Pick<ProjectRecord, "id" | "lanes">
  /** The cell that HOLDS the recording — a linked heard line's take writes to
   *  its cue sibling, not to the row that reads it. */
  owner: CellData
  /** THIS take's clip, which for a take on an added track is not the cell's
   *  default selection. */
  selectedAudioId: string
  /** The slot the clip lives in, from a caller that knows it (see
   *  `TranscribeCellArgs.slot` — an inference can get this wrong). */
  slot?: string
  session: TranscribeCellArgs["session"]
  /** Lane being worked in; omitted for the default lane. */
  targetLang?: string
  /** A split take is transcribed whole, every piece together. */
  pieces?: readonly AudioAttachmentOut[]
  /** Flush the queued `cell.audio.attach` that carries the timings. */
  onCommitted?: (cellId: string) => void | Promise<void>
}

/**
 * Transcribe one take and land its timings. Never throws: `transcribeCell`
 * stores failures in the transcribe-status store, which is what both the
 * Recording tab's badge and the row's gutter badge read.
 */
export async function transcribeTake({
  project, owner, selectedAudioId, slot, session, targetLang, pieces, onCommitted,
}: TranscribeTakeArgs): Promise<void> {
  await transcribeCell({
    cell: { ...owner, selectedAudioId },
    slot,
    session,
    projectId: project.id,
    language: asrLanguageForTake(owner, project.lanes, targetLang),
    // AQU-1978: the timings are written in this lane, never the `''` one.
    ...(targetLang ? { targetLang } : {}),
    askAgain: true,
    ...(pieces ? { pieces } : {}),
  })
  // The transcript rides a queued cell.audio.attach — flush it, then poke the
  // OWNER's file so its attachment read picks the timings up.
  await onCommitted?.(owner.id)
  notifyAudioAttachmentsChanged(owner.fileId)
}
