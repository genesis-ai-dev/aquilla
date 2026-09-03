// The shape a clip's peaks are drawn as. (AQU-646)
//
// Surface-neutral on purpose: the timeline draws it as an SVG path string and
// the Recording tab draws it onto a canvas, and Sam asked for both to look like
// the same take. Anything that knows about pixels-per-second, viewBoxes or
// canvas contexts belongs to the caller, not here.
//
// A FILLED ENVELOPE, NOT BARS. Bars were inherited from the Recording tab's
// original strip and Sam retired them: they make the trim handles blend into
// the chip, and "it's a little tacky if we can just do better." The envelope is
// also what every DAW draws at region scale — and, like ours, from peaks rather
// than samples, because the real oscillating waveform is not something you can
// hold for a whole episode.
//
// It is cheaper as well as nicer. Bars needed a stride ladder (group N bins per
// bar, quantised to octaves) purely so a bar stayed a sensible number of pixels
// wide, which meant the path had to be rebuilt as you zoomed. An envelope is
// one polyline that the caller's transform stretches to any width, so THE SHAPE
// NO LONGER DEPENDS ON ZOOM AT ALL. That deleted ~40 lines of ladder.

/** Left in at the top and bottom so a full-scale peak does not touch the
 *  container's own border. Matches CellWaveform's long-standing `cssH - 2`. */
export const VERTICAL_INSET_PX = 2

export interface EnvelopePoint {
  /** Bin coordinate, at the bin's CENTRE. */
  x: number
  /** Half the bar's height in px — the envelope runs from `mid - y` to
   *  `mid + y`. */
  y: number
}

/**
 * One point per peak, at BIN CENTRES.
 *
 * The half-bin offset is not cosmetic. Bars were anchored at the *start* of the
 * bin they summarised, so a bin's worth of audio appeared up to ~94ms early on
 * a long clip — a systematic bias in the same direction as the playhead's
 * output-latency lead, and part of what made that lead noticeable. Centring the
 * points removes it rather than correcting for it later.
 *
 * `y` is HALF the drawn height, in pixels, so the caller mirrors it about the
 * midline. The 1px floor (i.e. 0.5 each way) is deliberate and matches what the
 * Recording tab has always drawn: a silent stretch inside a take is information
 * — it is the gap between words — and drawing nothing there reads as the take
 * having stopped rather than as quiet.
 */
export function envelopePoints(peaks: Float32Array, height: number): EnvelopePoint[] {
  const usable = Math.max(1, height - VERTICAL_INSET_PX)
  const out: EnvelopePoint[] = []
  for (let i = 0; i < peaks.length; i++) {
    const peak = peaks[i]
    const amp = Number.isFinite(peak) ? Math.abs(peak) : 0
    out.push({ x: i + 0.5, y: Math.max(0.5, (amp * usable) / 2) })
  }
  return out
}

/**
 * The envelope as an SVG path: out along the top edge, back along the bottom,
 * closed so it fills.
 *
 * Straight segments, no curve smoothing. A spline would look smoother and would
 * lie: 320 bins over a 30-second clip is ~94ms each, and drawing a confident
 * curve through them claims a resolution the peaks do not have.
 *
 * `mid` is passed rather than derived so the caller can centre the envelope in
 * a box whose height is not the same as the drawing height (the timeline's
 * viewBox height is the chip height, and the inset lives inside it).
 */
export function envelopePath(points: readonly EnvelopePoint[], mid: number): string {
  if (points.length === 0) return ""
  // A single bin has no run to trace; draw its bar directly or it disappears.
  if (points.length === 1) {
    const { x, y } = points[0]
    return `M${r(x - 0.5)} ${r(mid - y)}h1v${r(y * 2)}h-1z`
  }

  const top: string[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    top.push(`${i === 0 ? "M" : "L"}${r(p.x)} ${r(mid - p.y)}`)
  }
  const bottom: string[] = []
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i]
    bottom.push(`L${r(p.x)} ${r(mid + p.y)}`)
  }
  return `${top.join("")}${bottom.join("")}Z`
}

/** Two decimals is far below a device pixel at any zoom and keeps these strings
 *  — one per visible chip, rebuilt whenever the row height changes — about a
 *  third of the size they would otherwise be. */
function r(n: number): number {
  return Math.round(n * 100) / 100
}
