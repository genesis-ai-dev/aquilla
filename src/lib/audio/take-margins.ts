// What a recorded take's chip should show at rest (2026-08-14 round 5).
//
// The recorder deliberately captures MORE than the performance: a pre-roll ring
// keeps the head of the count-in so an early entrance survives (round 3), and a
// stop-grace keeps capturing for a beat so the last consonant's tail isn't cut
// off mid-sound. Both are real audio and neither is discardable — Sam's standing
// ruling is that a performer's breath is content, not noise.
//
// But a chip drawn at the FULL clip length is drawn wrong. Both margins stick
// out past the line the take was performed against, and the timeline's overlap
// rule then fires on takes that are perfectly placed: chip N's trailing margin
// reaches chip N+1's leading margin somewhere in the gap between two cues — a
// gap that exists in VTT-timed files because the cues were written by hand, and
// never existed in the MP3 imports the rule was designed against (where chips
// are spliced flush and there is no unowned space at all). Both chips are then
// blamed for one intersection in space neither of them owns, and because an
// at-fault chip is PAINTED short on its offending edge, the collision is
// invisible: a chip goes red over an edge the timeline refuses to draw.
//
// So the take is BORN trimmed to what was performed. Nothing is deleted — a trim
// is a playback window, so the margin stays in the file, and dragging the chip's
// edge handle outward walks it straight back. Sam, 2026-08-14: "we automatically
// pull them to remove the margin even though the margin still exists on either
// side and can be brought back very easily by a human moving the handles again."
//
// The keeps below are the slivers left INSIDE the window on purpose. Trimming
// flush to the mark would re-clip the attack that round 3 existed to rescue —
// the first consonant of a word begins fractionally before its voiced body — so
// the head keeps a little runway. The tail keep is smaller because a decaying
// sound is far more forgiving than a plosive's onset.

import { MIN_TARGET_LEN_SEC } from "@/lib/timeline/lane-timing"

/** Head runway kept inside the window, before the mark (Sam's number). */
export const HEAD_KEEP_MS = 35
/** Tail runway kept inside the window, after the stop press (Sam's number). */
export const TAIL_KEEP_MS = 10

export interface TakeMarginInput {
  /** Clip head captured BEFORE the mark, in ms. Absent on the MediaRecorder
   *  path, which has no pre-roll ring. */
  preRollMs?: number
  /** Clip tail captured AFTER the stop press, in ms. Absent likewise. */
  tailGraceMs?: number
  /** The whole clip's length, in ms. */
  durationMs: number
}

/**
 * The trim window a freshly recorded take should attach with — the performance
 * plus its keeps, with the machine-added margin outside the window but still in
 * the file.
 *
 * Returns an EMPTY object when there is nothing honest to trim: an unknown or
 * degenerate duration, margins the recorder didn't report (the webm branch), or
 * any case where trimming would leave a window shorter than a chip's minimum
 * length. Empty means "attach exactly as before" — never a guess.
 */
export function takeMarginTrims(input: TakeMarginInput): {
  trimStartMs?: number
  trimEndMs?: number
} {
  const { durationMs } = input
  if (!Number.isFinite(durationMs) || durationMs <= 0) return {}

  const preRollMs = Number.isFinite(input.preRollMs) ? Math.max(0, input.preRollMs!) : 0
  const tailGraceMs = Number.isFinite(input.tailGraceMs) ? Math.max(0, input.tailGraceMs!) : 0

  // Margin BEYOND the keep is what gets windowed out. A pre-roll shorter than
  // the keep is entirely runway already — nothing to trim.
  const headCutMs = Math.max(0, Math.round(preRollMs - HEAD_KEEP_MS))
  const tailCutMs = Math.max(0, Math.round(tailGraceMs - TAIL_KEEP_MS))
  if (headCutMs === 0 && tailCutMs === 0) return {}

  const start = Math.min(headCutMs, durationMs)
  const end = Math.max(0, durationMs - tailCutMs)
  // Degenerate arithmetic (a take shorter than its own margins — a stop pressed
  // almost immediately) attaches untrimmed rather than as a sliver.
  if (end - start < MIN_TARGET_LEN_SEC * 1000) return {}

  return {
    ...(start > 0 ? { trimStartMs: start } : {}),
    ...(end < durationMs ? { trimEndMs: end } : {}),
  }
}
