// The take being recorded, as a shape that grows. (AQU-1210, 2026-09-25)
//
// Sam's ruling for the recorder: while you record, the take is drawn as the
// same rectangle every saved take is drawn as, filling from the left as you
// speak — not a trace scrolling past. What it shows while it grows should be
// what the preview shows the moment you press Stop, so the two rules that
// decide the saved shape are the ones used here:
//
//   - each column is the loudest moment in it (PEAK, not an average), and
//   - the whole thing is scaled so the loudest moment so far reaches the top.
//
// Arithmetic only; the canvas and the microphone belong to AudioWaveform.

/** Below this, the running loudest moment does not stretch the shape: room
 *  noise before the first word must not be drawn at full height. */
export const LIVE_PEAK_FLOOR = 0.05

/** How many seconds the rectangle spans right now.
 *
 *  With a target it matches DurationBar's axis (the target plus its overrun
 *  headroom), so the rectangle's growing edge and the bar's fill move together.
 *  Without one it spans `fallbackSec`. Either way, once the take runs past the
 *  span the rectangle holds the whole take — the scale widens rather than the
 *  shape running off the edge. */
export function liveSpanSec(elapsedSec: number, targetSec: number | null, headroomSec: number, fallbackSec: number): number {
  const base = targetSec != null && targetSec >= 0 ? targetSec + headroomSec : fallbackSec
  return Math.max(base, elapsedSec, 0.001)
}

/**
 * The peak of each pixel column across `[0, spanSec)`, for the part recorded
 * so far. `times` (seconds since the take began, ascending) and `peaks` pair
 * up, one per animation frame; only the first `n` are live.
 *
 * Columns are usually finer than frames early in a take (60 frames a second
 * against ~100px a second), so a column no frame landed in holds the frame
 * before it rather than dropping to silence.
 */
export function columnPeaks(
  times: ArrayLike<number>,
  peaks: ArrayLike<number>,
  n: number,
  spanSec: number,
  columns: number,
  out: Float32Array = new Float32Array(Math.max(0, columns)),
): Float32Array {
  const cols = Math.max(0, Math.floor(columns))
  const perCol = spanSec / Math.max(1, cols)
  let i = 0
  let held = 0
  for (let c = 0; c < cols; c++) {
    const end = (c + 1) * perCol
    let peak = -1
    while (i < n && times[i] < end) {
      if (peaks[i] > peak) peak = peaks[i]
      i++
    }
    if (peak < 0) peak = held
    else held = peaks[i - 1]
    out[c] = peak
  }
  return out
}
