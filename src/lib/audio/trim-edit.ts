// Moving a take's trim edges, as arithmetic. (AQU-1210 / AQU-1217, 2026-09-25)
//
// The recorder's pre-save trim, the Recording tab and the Audio view card all
// let you drag a take's start and end lines. The rules are the same everywhere,
// and they are the ones the timeline chip already enforces:
//
//   - the edges cannot cross, and the kept part cannot get shorter than the
//     timeline's own minimum chip length — a take trimmed any shorter could not
//     be drawn or grabbed on the timeline afterwards;
//   - an edge dragged to (within a hair of) the clip's own edge CLEARS that
//     side's trim rather than leaving a 10ms sliver trimmed off.
//
// Seconds on the clip's own clock throughout; `null` means "the clip's edge".

import { MIN_TARGET_LEN_SEC } from "@/lib/timeline/lane-timing"

/** Within this of a clip edge, a trim edge snaps to "no trim on this side". */
export const TRIM_EDGE_CLEAR_SEC = 0.02
/** One arrow-key press. Shift moves ten times as far. */
export const TRIM_NUDGE_SEC = 0.01
export const TRIM_NUDGE_COARSE_SEC = 0.1

export interface TrimValue {
  start: number | null
  end: number | null
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

/** How far from the clip's edge counts as "at the edge". A pointer drag gets
 *  the snap zone; an arrow-key nudge is exact — its steps are smaller than the
 *  zone, and a first nudge in from the edge must not snap straight back. */
export interface MoveOpts {
  minLenSec?: number
  snap?: boolean
}

/** Move the start edge to `toSec`. */
export function moveTrimStart(v: TrimValue, toSec: number, durationSec: number, opts: MoveOpts = {}): TrimValue {
  if (!(durationSec > 0) || !Number.isFinite(toSec)) return v
  const { minLenSec = MIN_TARGET_LEN_SEC, snap = true } = opts
  const end = v.end ?? durationSec
  const t = clamp(toSec, 0, Math.max(0, end - minLenSec))
  return { start: t <= (snap ? TRIM_EDGE_CLEAR_SEC : 0) ? null : t, end: v.end }
}

/** Move the end edge to `toSec`. */
export function moveTrimEnd(v: TrimValue, toSec: number, durationSec: number, opts: MoveOpts = {}): TrimValue {
  if (!(durationSec > 0) || !Number.isFinite(toSec)) return v
  const { minLenSec = MIN_TARGET_LEN_SEC, snap = true } = opts
  const start = v.start ?? 0
  const t = clamp(toSec, Math.min(durationSec, start + minLenSec), durationSec)
  return { start: v.start, end: t >= durationSec - (snap ? TRIM_EDGE_CLEAR_SEC : 0) ? null : t }
}

/** The kept part's length in seconds. */
export function keptLengthSec(v: TrimValue, durationSec: number): number {
  return Math.max(0, (v.end ?? durationSec) - (v.start ?? 0))
}

/** Same window? Both sides compared to the millisecond, nulls equal. */
/** A trim line's position, to the hundredth — one arrow-key nudge (10ms) is
 *  always visible: "0:00.52", "1:02.30". */
export function formatTrimTime(sec: number): string {
  const cs = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * 100))
  const m = Math.floor(cs / 6000)
  const s = Math.floor((cs % 6000) / 100)
  return `${m}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`
}

export function sameTrim(a: TrimValue, b: TrimValue): boolean {
  const ms = (x: number | null) => (x == null ? null : Math.round(x * 1000))
  return ms(a.start) === ms(b.start) && ms(a.end) === ms(b.end)
}
