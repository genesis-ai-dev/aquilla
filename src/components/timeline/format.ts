// Display helpers for the timeline editor (pure).

import { formatVttTime } from "@/lib/video/vtt-generator"

/** `m:ss` (or `m:ss.t` with tenths). Guards NaN/negatives to 0. */
export function fmtClock(sec: number, withTenths = false): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const base = `${m}:${String(s).padStart(2, "0")}`
  if (!withTenths) return base
  const tenths = Math.floor((sec - Math.floor(sec)) * 10)
  return `${base}.${tenths}`
}

/** SUB-11: millisecond clock for the live drag readout — `formatVttTime`
 * (HH:MM:SS.mmm) with a zero hours field trimmed for width. */
export function fmtDragTime(sec: number): string {
  const t = formatVttTime(Math.max(0, sec))
  return t.startsWith("00:") ? t.slice(3) : t
}

// Candidate tick spacings (seconds). The ruler picks the smallest that keeps
// adjacent labels at least `minLabelPx` apart at the current zoom.
const NICE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

/** Pick a "nice" tick interval (seconds) for the current zoom. */
export function niceTickSec(pxPerSec: number, minLabelPx = 64): number {
  for (const step of NICE_STEPS) {
    if (step * pxPerSec >= minLabelPx) return step
  }
  return NICE_STEPS[NICE_STEPS.length - 1]
}

/**
 * Sam's D2 (2026-10-05): a cue's time as a person reads it in a list —
 * `m:ss`, with a tenth only when there is one (`0:02.7`), and an hours field
 * once the film runs past an hour (`1:02:03`). Rounded to the nearest tenth, so
 * a parser's `2.7119999999999997` reads `0:02.7` and `59.96` reads `1:00`
 * rather than `0:59.9`. Guards NaN/negatives to 0 like `fmtClock`.
 */
export function fmtCueClock(sec: number): string {
  const tenthsTotal = Number.isFinite(sec) && sec > 0 ? Math.round(sec * 10) : 0
  const whole = Math.floor(tenthsTotal / 10)
  const tenth = tenthsTotal % 10
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  const base = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
  return tenth ? `${base}.${tenth}` : base
}
