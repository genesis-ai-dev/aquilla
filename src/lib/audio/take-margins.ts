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

import { MIN_TARGET_LEN_SEC, targetOffsetMsFor } from "@/lib/timeline/lane-timing"
import type { CellData } from "@/hooks/useCells"

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

// ── AQU-1210: the operator's trim, before saving ─────────────────────────────
//
// After Stop the recorder now shows the take with its two trim lines, starting
// at the window it would be born with anyway (`defaultTakeWindow`). If the
// operator moves them, `composeTakeWindow` turns their window into what Save
// stores. Two promises, both pinned by tests:
//
//   - UNTOUCHED IS UNCHANGED. With no operator window the result is exactly the
//     default: same trims, same retime, byte for byte what Save sent before
//     this feature existed.
//   - THE KEPT PART STILL STARTS ON THE CUE. A head trim moves the take so its
//     first kept sample lands on the cue's own start (audible start = anchor +
//     head trim = cue start, the standing invariant above). Trimming silence
//     off the front therefore PULLS the speech onto the cue rather than leaving
//     it playing late by the trimmed amount — otherwise the timing check the
//     trim exists for would be meaningless. The tail line just closes the
//     window earlier and never moves the take.

export interface TakeCueTiming {
  /** The cue's start in seconds, or null/undefined for an untimed line. */
  startTime?: number | null
}

export interface TakeWindow {
  /** The lane offset to store (see TakeTrimInput.targetOffsetMs), or null for
   *  "emit no retime" — an untimed line, or a take nobody placed. */
  laneOffsetMs: number | null
  trimStartMs?: number
  trimEndMs?: number
}

/** The window a freshly stopped take is born with — exactly what Save has
 *  always computed, lifted out so the preview can show it first. */
export function defaultTakeWindow(input: {
  cue: TakeCueTiming
  preRollMs?: number
  tailGraceMs?: number
  durationMs: number
}): TakeWindow {
  const { cue, durationMs } = input
  const preRollMs = input.preRollMs ?? 0
  // Exactly what Save has always stored: the pre-roll's shift, through the
  // same helper (clamped so a take is never anchored before file zero).
  const laneOffsetMs = preRollMs > 0 && cue.startTime != null && Number.isFinite(cue.startTime)
    ? targetOffsetMsFor({ startTime: cue.startTime } as CellData, cue.startTime - preRollMs / 1000)
    : null
  return {
    laneOffsetMs,
    ...takeTrims({ targetOffsetMs: laneOffsetMs ?? undefined, tailGraceMs: input.tailGraceMs, durationMs }),
  }
}

/** Save's window: the default, or the operator's if they moved a line. */
export function composeTakeWindow(input: {
  cue: TakeCueTiming
  defaults: TakeWindow
  /** The operator's window in ms, null on a side for the clip's edge; null
   *  altogether when they never touched it. */
  operator: { startMs: number | null; endMs: number | null } | null
  durationMs: number
}): TakeWindow {
  const { cue, defaults, operator, durationMs } = input
  if (!operator) return defaults
  const startMs = operator.startMs != null && operator.startMs > 0 ? Math.round(operator.startMs) : undefined
  const endMs = operator.endMs != null && operator.endMs < durationMs ? Math.round(operator.endMs) : undefined
  const cueStartMs = cue.startTime != null && Number.isFinite(cue.startTime) ? Math.round(cue.startTime * 1000) : null
  // Placement follows the head: the first kept sample goes on the cue's start.
  // An untimed line has no cue to land on and is never retimed. A take whose
  // head was not moved off the default keeps the default's retime exactly
  // (including "none" for a compressed take that was only tail-trimmed).
  const headUnchanged = (startMs ?? 0) === (defaults.trimStartMs ?? 0)
  const laneOffsetMs = cueStartMs == null
    ? null
    : headUnchanged
      ? defaults.laneOffsetMs
      : offsetForAnchorMs(cueStartMs, cueStartMs - (startMs ?? 0))
  return {
    laneOffsetMs,
    ...(startMs != null ? { trimStartMs: startMs } : {}),
    ...(endMs != null ? { trimEndMs: endMs } : {}),
  }
}

/** Same arithmetic as lane-timing's targetOffsetMsFor, in ms: the offset that
 *  puts sample zero at `anchorMs`, clamped at file zero. */
function offsetForAnchorMs(cueStartMs: number, anchorMs: number): number {
  const floored = Math.max(-cueStartMs, anchorMs - cueStartMs)
  return floored === 0 ? 0 : floored
}
