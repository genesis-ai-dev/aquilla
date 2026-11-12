import { v7 as uuidv7 } from "uuid"
import type { TranslatableString } from "../parsers/core-types"
import type { ImportContext, MediaSegmentSpec } from "../import"

export type MediaTextSource = NonNullable<ImportContext["mediaTextSource"]>
export interface MediaTextSourceOption {
  id: string
  label: string
  source: MediaTextSource
}

/** Keep supplied cue boundaries, including gaps and overlaps. The preview
 * must resolve invalid ranges before any staged file or artifact is written.
 */
export function createMediaCueSpecs(
  cues: readonly TranslatableString[],
  durationMs?: number,
): MediaSegmentSpec[] {
  if (cues.length === 0) throw new Error("The text source has no segments.")
  return cues.map((cue, i) => {
    if (!cue.original.trim()) throw new Error(`Segment ${i + 1} has no wording.`)
    if (cue.start === undefined || cue.end === undefined ||
        !Number.isFinite(cue.start) || !Number.isFinite(cue.end) ||
        cue.start < 0 || cue.end < cue.start) {
      throw new Error(`Segment ${i + 1} needs valid start and end times.`)
    }
    const startMs = Math.round(cue.start * 1000)
    const endMs = Math.round(cue.end * 1000)
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) {
      throw new Error(`Segment ${i + 1} needs representable millisecond timings.`)
    }
    if (endMs <= startMs) {
      throw new Error(`Segment ${i + 1} is shorter than the timeline's millisecond precision.`)
    }
    if (durationMs !== undefined && endMs > Math.round(durationMs)) {
      throw new Error(`Segment ${i + 1} ends after the media.`)
    }
    return {
      cellId: uuidv7(), startMs, endMs,
      trimStartMs: startMs, trimEndMs: endMs,
      transcription: cue.original,
      ...(cue.metadata ? { metadata: cue.metadata } : {}),
    }
  }).sort((a, b) => a.startMs! - b.startMs!)
}
