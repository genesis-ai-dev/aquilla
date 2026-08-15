// Detecting — and undoing — a frame-rate mismatch between an imported audio
// VTT and the subtitles it is meant to line up with. (AQU-646)
//
// THE PROBLEM, measured on The Chosen episode 101 (2026-08-14). The audio VTT
// ships quantised at 24.000 fps; the subtitle VTT at 23.976. That is the NTSC
// pulldown mistake — frame numbers printed as timecode at 24 fps against a
// 23.976 master — and it makes every audio timestamp 0.1% too small. The error
// is invisible at the top of the episode and about 2.4 seconds by minute forty,
// which reads as "the transcript is roughly right but drifts", and sent us
// looking for a fuzzy many-to-many alignment problem that mostly wasn't there:
// correcting the timebase took the count of audio cues with no subtitle partner
// from 71 to 4, and word agreement where they do overlap from 65% to 97%.
//
// IT IS IN THE FILES AS DELIVERED. Nothing in our import path scales a
// timestamp, and it is worth keeping that true — this module is the one place
// allowed to, it does so only with the user's consent, and it records what it
// did in the import manifest.
//
// WHY A FRAME GRID IS A RELIABLE TELL. A timestamp authored at F fps lands on a
// multiple of 1/F, give or take the millisecond the file prints it to. Real
// files score overwhelmingly on their own rate and near chance on every other:
// measured across five real Chosen VTTs the winner takes 63–100% with a
// 1.7–2.0x margin over the runner-up, while random millisecond timestamps peak
// at 16% with no separation at all (1.02x). The thresholds below are picked
// from those numbers, not from taste.
//
// TWO SUBTLETIES THE THRESHOLDS ENCODE:
//
//   - A PHASE OFFSET IS NORMAL. A file that was time-shifted after authoring
//     still sits on its grid, just not starting at zero — the real subtitle
//     files sit about 1.7ms off. Ignoring phase scores 23.976 at 32% instead of
//     65% and the detection fails on perfectly good files. So phase is fitted,
//     not assumed.
//
//   - HARMONICS OUTRANK STRANGERS. Every 24 fps timestamp is also a 48 fps
//     timestamp, and half of them are 12 fps timestamps, so a faster rate can
//     never score worse than the true one. Candidates are therefore tried
//     SLOWEST FIRST and the slowest rate within a hair of the best wins. Get
//     this backwards and a 24 fps file is confidently reported as 60 fps.

/** Frame rates worth testing, SLOWEST FIRST — see the harmonics note above. */
const FRAME_RATES: readonly { label: string; fps: number }[] = [
  { label: "23.976", fps: 24000 / 1001 },
  { label: "24", fps: 24 },
  { label: "25", fps: 25 },
  { label: "29.97", fps: 30000 / 1001 },
  { label: "30", fps: 30 },
  { label: "50", fps: 50 },
  { label: "59.94", fps: 60000 / 1001 },
  { label: "60", fps: 60 },
]

/** How far off the grid a timestamp may sit and still count. A file printed to
 *  milliseconds loses up to 0.5ms to rounding; 1.1ms leaves a little room for
 *  a tool that truncated instead of rounding, without being loose enough to
 *  start collecting timestamps that belong to a different grid. */
const GRID_TOLERANCE_SEC = 0.0011

/** Below this the winner isn't a grid, it's a coincidence (random timestamps
 *  peak at 16%; the worst real file scores 63%). */
const MIN_FIT = 0.55

/** The winner must also clear the runner-up by this much. Real files manage
 *  1.7x and better; random data manages 1.02x. */
const MIN_MARGIN = 1.4

/** Fewer timestamps than this and the fit is not worth believing. A VTT with
 *  20 cues carries 40 timestamps, which is already plenty; this only rules out
 *  the degenerate handful. */
const MIN_SAMPLES = 40

/** Ratios closer to 1 than this are not worth a dialog: 0.05% is under two
 *  frames across a whole hour, i.e. below anything anyone can see. */
const MIN_SCALE_DELTA = 0.0005

export interface FrameRateGuess {
  /** How the rate is written for people ("23.976"), not a rounded number. */
  label: string
  fps: number
  /** Share of timestamps landing on the grid, 0–1. */
  fit: number
  /** The grid's offset from zero, seconds — a time-shifted file still fits. */
  phaseSec: number
  /** The best score any OTHER rate managed, 0–1. The margin is the evidence. */
  runnerUpFit: number
}

/** Wrap `value` into `[0, span)` — residuals and phases are circular. */
function wrap(value: number, span: number): number {
  const m = value % span
  return m < 0 ? m + span : m
}

/** Fit one candidate rate: find the grid phase most timestamps agree on, then
 *  count how many actually land on it. Three linear passes, no search. */
function fitRate(times: readonly number[], fps: number): { fit: number; phaseSec: number } {
  const frame = 1 / fps
  // Where each timestamp sits WITHIN its frame. A file on this grid piles these
  // up at one value (its phase); a file on a different grid spreads them flat.
  const residuals = times.map((t) => wrap(t, frame))

  // Histogram at the tolerance's own width, so the winning bucket is already
  // the answer to within one tolerance.
  const binCount = Math.max(1, Math.ceil(frame / GRID_TOLERANCE_SEC))
  const binWidth = frame / binCount
  const bins = new Array<number>(binCount).fill(0)
  for (const r of residuals) bins[Math.min(binCount - 1, Math.floor(r / binWidth))]++

  // A phase can straddle a bin edge, so score each bin together with its two
  // neighbours (circular) and take the best window.
  let bestBin = 0
  let bestScore = -1
  for (let i = 0; i < binCount; i++) {
    const score =
      bins[(i - 1 + binCount) % binCount] + bins[i] + bins[(i + 1) % binCount]
    if (score > bestScore) {
      bestScore = score
      bestBin = i
    }
  }

  // Refine: the mean of the residuals in that window, unwrapped around its
  // centre so a phase sitting near zero isn't averaged with one near a full
  // frame into something halfway between.
  const centre = (bestBin + 0.5) * binWidth
  let sum = 0
  let n = 0
  for (const r of residuals) {
    let d = r - centre
    if (d > frame / 2) d -= frame
    else if (d < -frame / 2) d += frame
    if (Math.abs(d) <= binWidth * 1.5) {
      sum += d
      n++
    }
  }
  const phaseSec = n > 0 ? wrap(centre + sum / n, frame) : centre

  let hits = 0
  for (const r of residuals) {
    let d = r - phaseSec
    if (d > frame / 2) d -= frame
    else if (d < -frame / 2) d += frame
    if (Math.abs(d) <= GRID_TOLERANCE_SEC) hits++
  }
  return { fit: hits / times.length, phaseSec }
}

/**
 * Which frame rate these timestamps were authored at, or null when the answer
 * isn't clear enough to act on. Pure; no I/O.
 */
export function detectFrameRate(times: readonly number[]): FrameRateGuess | null {
  const usable = times.filter((t) => Number.isFinite(t) && t >= 0)
  if (usable.length < MIN_SAMPLES) return null

  const scored = FRAME_RATES.map((r) => ({ ...r, ...fitRate(usable, r.fps) }))
  const best = scored.reduce((a, b) => (b.fit > a.fit ? b : a))
  // Slowest-first: anything within a whisker of the best beats it, because a
  // harmonic of the true rate always ties or wins on raw fit.
  const winner = scored.find((s) => s.fit >= best.fit - 0.02) ?? best
  const runnerUpFit = scored.reduce(
    (max, s) => (s.label === winner.label ? max : Math.max(max, s.fit)),
    0,
  )

  if (winner.fit < MIN_FIT) return null
  if (runnerUpFit > 0 && winner.fit < runnerUpFit * MIN_MARGIN) return null
  return {
    label: winner.label,
    fps: winner.fps,
    fit: winner.fit,
    phaseSec: winner.phaseSec,
    runnerUpFit,
  }
}

export interface TimebaseCorrection {
  /** The rate the imported cues were authored at. */
  cue: FrameRateGuess
  /** The rate the file they are joining was authored at — the one to match. */
  reference: FrameRateGuess
  /**
   * Multiply every cue time by this. A frame index printed at `cue.fps` really
   * lands at that index over `reference.fps`, so the fix is the ratio of the
   * two rates — no fitting, no measured slope, just the arithmetic the mistake
   * implies.
   */
  scale: number
  /** What the correction is worth at the far end of the import, in seconds —
   *  the number worth quoting, since the drift at the start is always ~0. */
  driftAtEndSec: number
}

export interface PlanTimebaseArgs {
  /** Every start and end in the file being imported, seconds. */
  cueTimes: readonly number[]
  /** Every start and end already on the file it is joining, seconds. */
  referenceTimes: readonly number[]
  /** The last cue's end, for quoting the worst-case drift. */
  lastCueSec: number
}

/**
 * Work out whether the incoming cues are on a different frame grid from the
 * file they are joining, and by how much. Null when either side can't be read
 * confidently, when they agree, or when the disagreement is too small to
 * bother anyone about.
 *
 * Deliberately symmetric: it will just as happily report cues that are too
 * SLOW as too fast. The Chosen's episode 101 happens to be 24-against-23.976,
 * but nothing here assumes that, and hardcoding 1.001 would quietly do the
 * wrong thing the first time a file arrives the other way round.
 */
export function planTimebaseCorrection({
  cueTimes,
  referenceTimes,
  lastCueSec,
}: PlanTimebaseArgs): TimebaseCorrection | null {
  const cue = detectFrameRate(cueTimes)
  if (!cue) return null
  const reference = detectFrameRate(referenceTimes)
  if (!reference) return null
  const scale = cue.fps / reference.fps
  if (Math.abs(scale - 1) < MIN_SCALE_DELTA) return null
  return {
    cue,
    reference,
    scale,
    driftAtEndSec: Math.max(0, lastCueSec) * (scale - 1),
  }
}

/** Milliseconds are the storage unit downstream, so land on one here rather
 *  than carrying a float that re-rounds differently at each hop. */
export function applyTimebaseScale(sec: number, scale: number): number {
  return Math.round(sec * scale * 1000) / 1000
}
