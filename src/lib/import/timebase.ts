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

import { tokens } from "@/lib/timeline/cue-links"

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

// ── Measuring the drift directly ─────────────────────────────────────────
//
// THE GRID FINGERPRINT ASKS THE WRONG QUESTION (2026-08-17). It infers each
// file's ABSOLUTE authoring rate from how its timestamps quantise, and that
// signal can be destroyed by ordinary editing. Episode 306's subtitles are the
// case: cut far finer than the others (1019 rows against 650-869), enough of
// them reflowed slightly off the grid that 23.976 scored 0.518 against the 0.55
// floor below. The detector declined, no correction was planned, and a 24fps
// audio VTT was imported drifting against 23.976 subtitles — the very bug this
// module exists to prevent, reintroduced in silence. Only 61% of its heard
// lines found a subtitle, against 98% for every other episode.
//
// Nothing was wrong with the file. On 306 the runner-up rates score 0.066-0.141,
// so 23.976 wins by 3.7x — the WIDEST margin of the four episodes. The evidence
// was overwhelming and the absolute number was simply low.
//
// What we actually need is not either file's rate but the DRIFT BETWEEN THEM,
// and that is directly measurable. Take lines whose wording is unique in both
// files, which pairs them without consulting a single timestamp, and see how
// the gap between their times grows. A frame-rate error is a straight line
// through those points; agreement is a flat one. It cannot be destroyed by
// requantising either file, it works for rates nobody thought to list, and it
// is the same "consistent growing drift" a person sees by eye.

/** The minimum a line must carry to anchor a drift measurement. */
export interface TimedLine {
  startTime?: number
  original?: string
}

export interface DriftMeasurement {
  /** `referenceTime ~= scale x cueTime`. 1 means the two files agree. */
  scale: number
  /** What is left after scaling — a file SHIFTED rather than stretched. */
  offsetSec: number
  /** Uniquely-worded lines matched across the two files. The evidence. */
  anchors: number
  /** First anchor to last. A slope measured across ninety seconds is noise. */
  spanSec: number
}

/** Fewer anchors than this and the median is not a measurement. */
const MIN_ANCHORS = 25
/** A drift of 0.1% is 0.6s across ten minutes; below that span, rounding wins. */
const MIN_SPAN_SEC = 600
/** Slopes are taken across pairs at least this far apart. A 0.1% stretch is one
 *  millisecond over a second — invisible between neighbours, plain across five
 *  minutes — so short baselines contribute nothing but noise to the median. */
const MIN_BASELINE_SEC = 300
/** Anchors need this many words. "Yes." is unique in no file worth the name. */
const MIN_ANCHOR_TOKENS = 2

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Lines keyed by their wording, keeping only keys that occur EXACTLY ONCE. */
function uniqueByWording(lines: readonly TimedLine[]): Map<string, number> {
  const seen = new Map<string, number | null>()
  for (const line of lines) {
    if (typeof line.startTime !== "number" || !Number.isFinite(line.startTime)) continue
    const key = tokens(line.original ?? "").join(" ")
    if (key === "" || key.split(" ").length < MIN_ANCHOR_TOKENS) continue
    // Second sighting poisons the key: an ambiguous line is no anchor at all.
    seen.set(key, seen.has(key) ? null : line.startTime)
  }
  const out = new Map<string, number>()
  for (const [k, t] of seen) if (t !== null) out.set(k, t)
  return out
}

/**
 * How much the two files drift apart, measured on the lines they share.
 *
 * Pure; no I/O. Null when there is not enough to measure, which is a real
 * answer and must be reported as one rather than treated as "no drift".
 *
 * ANCHORS ARE FOUND BY WORDING ALONE. That is the whole point: a pair three
 * seconds adrift by minute forty still anchors, where anything time-based has
 * already lost them. The tokeniser is the matcher's own, so the curly-apostrophe
 * fold applies here too — without it 37 of episode 101's cues key wrong.
 *
 * THE SLOPE IS A MEDIAN, not a least-squares fit. One mis-paired line — a stock
 * phrase that happens to be unique in both files by accident — would drag a
 * least-squares slope; it cannot move a median. Pairs closer together than
 * `MIN_BASELINE_SEC` are skipped, because a 0.1% stretch across two neighbouring
 * lines is smaller than the millisecond the files are printed to.
 */
export function measureDrift({
  cueLines,
  referenceLines,
}: {
  cueLines: readonly TimedLine[]
  referenceLines: readonly TimedLine[]
}): DriftMeasurement | null {
  const cueByKey = uniqueByWording(cueLines)
  const refByKey = uniqueByWording(referenceLines)
  const pairs: { cue: number; ref: number }[] = []
  for (const [key, cue] of cueByKey) {
    const ref = refByKey.get(key)
    if (ref !== undefined) pairs.push({ cue, ref })
  }
  if (pairs.length < MIN_ANCHORS) return null
  pairs.sort((a, b) => a.cue - b.cue)
  const spanSec = pairs[pairs.length - 1].cue - pairs[0].cue
  if (spanSec < MIN_SPAN_SEC) return null

  const slopes: number[] = []
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const run = pairs[j].cue - pairs[i].cue
      if (run < MIN_BASELINE_SEC) continue
      slopes.push((pairs[j].ref - pairs[i].ref) / run)
    }
  }
  if (slopes.length === 0) return null
  const scale = median(slopes)
  if (!Number.isFinite(scale) || scale <= 0) return null
  return {
    scale,
    offsetSec: median(pairs.map((p) => p.ref - scale * p.cue)),
    anchors: pairs.length,
    spanSec,
  }
}

/** How far a measured slope may sit from a real frame ratio and still be
 *  called that ratio. 24/23.976 and 25/24 differ by 4%, so this is nowhere
 *  near tight enough to confuse two of them. */
const RATIO_TOLERANCE = 0.0004

export interface FrameRatio {
  /** The rate the cues behave as if they were authored at, or null when the
   *  ratio names several pairs equally well and nothing broke the tie. */
  cue: string | null
  /** The rate they need to be on. Null under the same condition. */
  reference: string | null
  ratio: number
}

/**
 * The frame-rate mistake a measured slope corresponds to, or null when it
 * matches none of them.
 *
 * APPLY THE NAMED RATIO, NEVER THE RAW SLOPE. A pulldown error is an exact
 * ratio of two rates; a measurement of it is 1.0009987 when the truth is
 * 1.0010010. Snapping keeps the arithmetic exact, and gives the notice
 * something a person can check ("24 against 23.976") instead of a decimal.
 *
 * A drift matching nothing here is still real and still worth reporting — a
 * trimmed master does it — but it is not a recognised mistake, so the caller
 * treats it more cautiously.
 */
export function snapToFrameRatio(
  scale: number,
  /** Rates either side is independently known to be on. THE RATIO ALONE IS
   *  AMBIGUOUS: 24/23.976 and 30/29.97 are both exactly 1001/1000, so a
   *  measured 1.001 names four different pairs equally well and picking by
   *  loop order told episode 101 it was a 30fps file. Whatever the grid
   *  fingerprint could read breaks the tie. */
  prefer?: { cue?: string; reference?: string },
): FrameRatio | null {
  const within: FrameRatio[] = []
  for (const from of FRAME_RATES) {
    for (const to of FRAME_RATES) {
      if (from.label === to.label) continue
      const ratio = from.fps / to.fps
      if (Math.abs(ratio - scale) < RATIO_TOLERANCE) {
        within.push({ cue: from.label, reference: to.label, ratio })
      }
    }
  }
  if (within.length === 0) return null
  const score = (r: FrameRatio) =>
    (prefer?.cue === r.cue ? 2 : 0) + (prefer?.reference === r.reference ? 1 : 0)
  const best = within.reduce((a, r) => (score(r) > score(a) ? r : a))
  // NAMING IS OPTIONAL; THE RATIO IS NOT. When several pairs fit equally well
  // and nothing the grids could read picks one, we know exactly how fast the
  // cues run and NOT what rate they were authored at — 24-against-23.976 and
  // 30-against-29.97 are both precisely 1001/1000, so the correction is
  // identical either way and only the sentence describing it could be wrong.
  // Saying "24 frames per second" on a 30fps show would be a confident
  // falsehood bolted to a correct fix, so it goes unnamed instead.
  if (score(best) === 0 && within.length > 1) {
    return { cue: null, reference: null, ratio: best.ratio }
  }
  return best
}

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
  // A HARMONIC IS NOT A RIVAL, and leaving it in the runner-up made three
  // rates undetectable (2026-08-18). Every 30fps timestamp is also a 60fps
  // timestamp, so 60 scores exactly what 30 does; the margin test below then
  // compares 30 against a perfect tie and refuses to name it. Same for 25
  // against 50 and 29.97 against 59.94 — half the list, silently unreadable,
  // and unnoticed only because The Chosen is 24 against 23.976 and 48 is not
  // a rate anyone lists. The slowest-first rule above already decided the
  // harmonic is not the answer; it must not then be treated as evidence
  // against the answer.
  const isHarmonicOfWinner = (fps: number) => {
    const times = fps / winner.fps
    return times > 1.5 && Math.abs(times - Math.round(times)) < 0.01
  }
  const runnerUpFit = scored.reduce(
    (max, s) =>
      s.label === winner.label || isHarmonicOfWinner(s.fps) ? max : Math.max(max, s.fit),
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
  /** The incoming lines WITH their words, for the direct drift measurement.
   *  Absent falls back to the grid fingerprint alone, which is how this
   *  behaved before 2026-08-17. */
  cueLines?: readonly TimedLine[]
  /** The lines already on the file being joined, with their words. */
  referenceLines?: readonly TimedLine[]
}

/**
 * What we were able to establish about the two files' timing — and it is a
 * VERDICT, with a name for every outcome, rather than a correction-or-null.
 *
 * The null used to mean three different things: they agree, the drift is too
 * small to care about, and "I could not tell". Only the last is worth
 * interrupting someone over, and it was the one that vanished — episode 306
 * imported wrong with no correction, no message, and nothing on screen to say
 * a check had been declined. A refusal to guess is fine. An invisible one is
 * how a whole episode goes bad quietly.
 */
export type TimebaseVerdict =
  | ({
      kind: "correct"
      /** True when the drift matches a real frame-rate mistake AND we can say
       *  which. False for the two quite different reasons below. */
      namedRatio: boolean
      /** The drift IS a known pulldown ratio, but several frame pairs give
       *  that exact ratio and nothing could choose between them. The
       *  correction is exact; only its name is unavailable. */
      ambiguousRates?: boolean
      /** Set when the direct measurement is what found it. */
      measured?: DriftMeasurement
      /** True when the grid fingerprint and the measurement disagree — worth
       *  saying out loud rather than silently preferring one. */
      disputed?: boolean
    } & TimebaseCorrection)
  | { kind: "aligned"; measured?: DriftMeasurement }
  | { kind: "unmeasurable"; reason: string }

const UNNAMED: FrameRateGuess = {
  label: "unknown",
  fps: 0,
  fit: 0,
  phaseSec: 0,
  runnerUpFit: 0,
}

/**
 * Work out whether the incoming cues run at a different speed from the file
 * they are joining, and by how much.
 *
 * TWO METHODS, AND THE DIRECT ONE LEADS. `measureDrift` pairs lines by their
 * wording and measures how far apart they pull; the grid fingerprint infers
 * each file's authoring rate from timestamp quantisation. The measurement is
 * the better evidence — it survives a requantised file, which is exactly what
 * defeated the fingerprint on episode 306 — but the fingerprint is what can
 * NAME the rates, so it still runs, and both go into the verdict.
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
  cueLines,
  referenceLines,
}: PlanTimebaseArgs): TimebaseVerdict {
  // Each side detected on its own. 306 is why: its AUDIO grid reads perfectly
  // (24 fps, fit 1.00) while its subtitles do not, and that half-answer is
  // still enough to name which rate the cues are on.
  const cueGrid = detectFrameRate(cueTimes)
  const referenceGrid = detectFrameRate(referenceTimes)
  const grid =
    cueGrid && referenceGrid
      ? { cue: cueGrid, reference: referenceGrid, scale: cueGrid.fps / referenceGrid.fps }
      : null

  const measured =
    cueLines && referenceLines
      ? measureDrift({ cueLines, referenceLines })
      : null

  // The direct measurement leads when there is one.
  if (measured) {
    const snapped = snapToFrameRatio(measured.scale, {
      cue: cueGrid?.label,
      reference: referenceGrid?.label,
    })
    const scale = snapped?.ratio ?? measured.scale
    if (Math.abs(scale - 1) < MIN_SCALE_DELTA) return { kind: "aligned", measured }
    // Name the rates from the fingerprint when it agrees; otherwise from the
    // ratio the slope snapped to; otherwise not at all. `snapped.cue` is null
    // when the ratio fits several pairs and nothing chose between them — a
    // correction we can apply exactly but cannot describe in frames.
    const named =
      snapped?.cue != null && snapped.reference != null
        ? {
            cue:
              cueGrid?.label === snapped.cue ? cueGrid : { ...UNNAMED, label: snapped.cue },
            reference:
              referenceGrid?.label === snapped.reference
                ? referenceGrid
                : { ...UNNAMED, label: snapped.reference },
          }
        : { cue: UNNAMED, reference: UNNAMED }
    return {
      kind: "correct",
      namedRatio: snapped?.cue != null && snapped.reference != null,
      ...(snapped != null && snapped.cue == null ? { ambiguousRates: true } : {}),
      measured,
      ...(grid && Math.abs(grid.scale - scale) > RATIO_TOLERANCE ? { disputed: true } : {}),
      cue: named.cue,
      reference: named.reference,
      scale,
      driftAtEndSec: Math.max(0, lastCueSec) * (scale - 1),
    }
  }

  // Nothing to measure against — fall back to the fingerprint.
  if (!grid) {
    return {
      kind: "unmeasurable",
      reason: cueLines && referenceLines
        ? "too few lines are worded the same in both files to measure the drift, and neither file's timing grid could be read"
        : "neither file's timing grid could be read",
    }
  }
  if (Math.abs(grid.scale - 1) < MIN_SCALE_DELTA) return { kind: "aligned" }
  return {
    kind: "correct",
    namedRatio: true,
    cue: grid.cue,
    reference: grid.reference,
    scale: grid.scale,
    driftAtEndSec: Math.max(0, lastCueSec) * (grid.scale - 1),
  }
}

/** Milliseconds are the storage unit downstream, so land on one here rather
 *  than carrying a float that re-rounds differently at each hop. */
export function applyTimebaseScale(sec: number, scale: number): number {
  return Math.round(sec * scale * 1000) / 1000
}
