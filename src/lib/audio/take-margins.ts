// Where a recorded take's chip STARTS at rest (2026-08-14 round 5).
//
// The recorder deliberately captures more than the performance: a pre-roll ring
// keeps the head of the count-in so an early entrance survives (round 3), and a
// stop-grace keeps capturing for a beat so the last consonant isn't cut off
// mid-sound. Both are real audio and neither is discardable — Sam's standing
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
// So the take is BORN trimmed. Nothing is deleted — a trim is a playback window,
// so the margin stays in the file, and dragging the chip's edge handle outward
// walks it straight back. Sam, 2026-08-14: "we automatically pull them to remove
// the margin even though the margin still exists on either side and can be
// brought back very easily by a human moving the handles again."
//
// THE HEAD RULE IS ALIGNMENT, NOT SUBTRACTION (Sam, 2026-08-14: "just make the
// handlebars trim back to the start of the section in alignment with the vtt
// timing of the corresponding cell"). The window opens exactly on the cue's own
// start. Deriving it from the ANCHOR rather than from the pre-roll is what makes
// that exact: the ring keeps whole buffers, so the kept head is never precisely
// the requested 200ms — it lands anywhere in a range — and the anchor is
// additionally clamped at file zero for a line near the very start of a film.
// Undoing whatever shift was actually stored lands on the cue every time;
// subtracting a nominal margin would leave exactly the drift Sam kept seeing.

import { MIN_TARGET_LEN_SEC } from "@/lib/timeline/lane-timing"

/** Tail runway kept inside the window, after the stop press (Sam's number).
 *  Smaller than any head allowance would be: a decaying sound is far more
 *  forgiving than a plosive's onset. */
export const TAIL_KEEP_MS = 10

export interface TakeTrimInput {
  /** What the saver is about to store as this take's lane offset: where the
   *  clip's sample zero sits RELATIVE to the cell's own start, in ms. Negative
   *  for a take anchored early (the normal case — the pre-roll's other half). */
  targetOffsetMs?: number
  /** Clip tail captured AFTER the stop press, in ms. Absent on the
   *  MediaRecorder path, which has no grace at all. */
  tailGraceMs?: number
  /** The whole clip's length, in ms. */
  durationMs: number
}

/**
 * The trim window a freshly recorded take should attach with: opening exactly on
 * its cue's start, closing just past the end of the performance. The margin
 * outside the window stays in the file, one handle-drag away.
 *
 * Returns an EMPTY object when there is nothing honest to trim: an unknown or
 * degenerate duration, a take that isn't anchored early and has no reported
 * grace, or any case where trimming would leave a window shorter than a chip's
 * minimum length. Empty means "attach exactly as before" — never a guess.
 */
export function takeTrims(input: TakeTrimInput): {
  trimStartMs?: number
  trimEndMs?: number
} {
  const { durationMs } = input
  if (!Number.isFinite(durationMs) || durationMs <= 0) return {}

  // The head trim UNDOES the anchor shift, so audible start = anchor + trim
  // = the cell's own start. A take anchored at or after its line has no head
  // margin to window out.
  const offsetMs = Number.isFinite(input.targetOffsetMs) ? input.targetOffsetMs! : 0
  const headCutMs = offsetMs < 0 ? Math.round(-offsetMs) : 0

  const tailGraceMs = Number.isFinite(input.tailGraceMs) ? Math.max(0, input.tailGraceMs!) : 0
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
