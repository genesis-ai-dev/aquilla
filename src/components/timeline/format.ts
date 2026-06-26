// Display helpers for the timeline editor (pure).

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
