// Drawing a take's waveform inside its timeline chip. (AQU-646)
//
// Pure and DOM-free, for the same reason track-reorder.ts is: the pointer and
// canvas layers are the parts that cannot be unit-tested cheaply, so everything
// that can be wrong by one bin lives here instead.
//
// THE ONE IDEA: the path is built over the WHOLE CLIP, in bin coordinates, and
// the visible window is expressed as an SVG viewBox over it. Nothing is
// re-sliced when the chip is trimmed, dragged, zoomed, or painted short — the
// browser scales one attribute. That is why this module returns a window and a
// path separately, and why the path never takes the window as an argument.
//
// Peaks come from `decodePeaks` (lib/audio/peaks.ts) at a FIXED bin count, so
// the timeline shares one OPFS cache with the Recording tab in both directions.
// They are normalised so the loudest bin is 1.0 — strictly upward, never down
// (peaks.ts only scales when `max < 1`), so a clipped take is left alone.

import type { TargetChipGeom } from "./lane-timing"

/** Roughly one bar per this many CSS pixels. Below ~2px bars stop reading as
 *  separate strokes and the waveform turns into a grey block; much above 4px
 *  and a short take looks like a bar chart. */
const PX_PER_BAR = 3

/** The narrowest chip still worth drawing bars in. Under this the chip is a
 *  sliver of colour and bars would be noise. */
const MIN_BARS = 4

/** A group can cover at most this many bins. Purely a sanity bound: at 320 bins
 *  a stride of 64 is already only 5 bars. */
const MAX_STRIDE = 64

/** Left in the box top and bottom so a full-scale bar does not touch the chip's
 *  own border. Matches CellWaveform's `cssH - 2`. */
const VERTICAL_INSET_PX = 2

export interface ChipWaveformWindow {
  /** First visible bin coordinate (fractional — it is a viewBox origin, not an
   *  index). */
  x0: number
  /** Last visible bin coordinate. Always > x0. */
  x1: number
}

/**
 * Which slice of the clip the chip is currently showing, in bin coordinates.
 *
 * Null means "draw nothing", and it is returned for three genuinely different
 * reasons that all have the same answer:
 *   - the clip's length was never measured, so no bin maps to any second;
 *   - the window is empty or inverted (corrupt trims, a zero-width chip);
 *   - there are no peaks yet.
 *
 * WHY THE ANCHOR IS RECOMPUTED WHILE DRAGGING. A take is anchored at its clip's
 * sample zero, and `geom.anchor` is where that zero sits AT REST. During a MOVE
 * the whole clip travels with the chip, so the window must be measured against
 * where zero has been dragged TO — otherwise the waveform appears to slide
 * around inside its own chip. During a TRIM the clip does not move at all
 * (that is what makes trimming non-destructive), so the resting anchor is
 * already right, and the window widening is exactly the point: the head margin
 * scrolls into view as the handle is pulled back.
 */
export function chipWaveformWindow(args: {
  geom: TargetChipGeom
  /** The chip's drawn edges in file seconds — already cut short by the SUB-48
   *  at-fault rule at rest, already restored on hover. Passing the PAINTED
   *  edges rather than the true ones is what makes the hidden tail appear in
   *  place when the chip is engaged, with nothing already drawn moving. */
  paintedStart: number
  paintedEnd: number
  /** The live span while a drag is in flight, and the drag's kind. Absent at
   *  rest. */
  drag?: { mode: "move" | "resize-l" | "resize-r"; spanStart: number } | null
  /** How many bins the peaks array actually has. */
  bins: number
}): ChipWaveformWindow | null {
  const { geom, paintedStart, paintedEnd, drag, bins } = args
  const clipLen = geom.durationSec
  // Gate on the DURATION, not on `usingFallback`. They are not the same test: a
  // clip carrying a trimEnd but no measured duration returns usingFallback
  // false with durationSec null (see targetChipGeom), and drawing a waveform
  // scaled to a guessed length would make a guess look measured — the one thing
  // the whole dashed-border/`?`-badge treatment exists to prevent.
  if (clipLen == null || !(clipLen > 0)) return null
  if (!Number.isFinite(bins) || bins <= 0) return null

  const liveAnchor =
    drag?.mode === "move" ? drag.spanStart - geom.trimStartSec : geom.anchor
  if (!Number.isFinite(liveAnchor)) return null

  const toBin = (sec: number) => ((sec - liveAnchor) / clipLen) * bins
  // Clamped because `targetChipGeom` never checks trimEndMs against durationMs,
  // so persisted data CAN describe a window running off the end of its own clip.
  const x0 = clamp(toBin(paintedStart), 0, bins)
  const x1 = clamp(toBin(paintedEnd), 0, bins)
  if (!(x1 - x0 > 0)) return null
  return { x0, x1 }
}

/**
 * How many bins each drawn bar covers.
 *
 * A POWER OF TWO, and that is the point rather than a micro-optimisation: the
 * stride is the only input to the path that changes with zoom, so quantising it
 * to octaves means a zoom glide from 8 to 240 px/s rebuilds the path about five
 * times in total instead of once per animation frame. Between octaves the bars
 * simply stretch, which is imperceptible because they stay inside a 2-4px band.
 *
 * Groups are reduced by MAX, never resampled or averaged — averaging a speech
 * waveform down to a tenth of its bins produces uniform grey mush, because the
 * peaks that carry the shape of the words are exactly the outliers averaging
 * removes.
 */
export function waveformStride(windowBins: number, paintedPx: number): number {
  if (!Number.isFinite(windowBins) || windowBins <= 0) return 1
  if (!Number.isFinite(paintedPx) || paintedPx <= 0) return MAX_STRIDE
  const wantBars = Math.max(MIN_BARS, Math.round(paintedPx / PX_PER_BAR))
  const raw = windowBins / wantBars
  if (raw <= 1) return 1
  const octave = 2 ** Math.round(Math.log2(raw))
  return clamp(octave, 1, MAX_STRIDE)
}

/**
 * The `d` of one `<path>` covering the WHOLE clip, in bin coordinates
 * horizontally and CSS pixels vertically.
 *
 * The y unit is pixels (not a 0..1 normal) so the caller can set the viewBox
 * height to the chip height and get `Math.max(1, v * (h - 2))` exactly — the
 * same formula CellWaveform draws with, including its 1px floor, so a silent
 * bin is a visible hairline in both places rather than nothing in one of them.
 *
 * Bars are centred on the midline and separated by a proportional gap, so the
 * gap never depends on pixel width and therefore never forces a rebuild.
 */
export function waveformPathD(
  peaks: Float32Array,
  stride: number,
  chipH: number,
): string {
  const step = Math.max(1, Math.floor(stride))
  const height = Math.max(1, chipH - VERTICAL_INSET_PX)
  const mid = chipH / 2
  const barW = step * 0.8
  const parts: string[] = []

  for (let start = 0; start < peaks.length; start += step) {
    let peak = 0
    const end = Math.min(peaks.length, start + step)
    for (let i = start; i < end; i++) {
      const v = peaks[i]
      if (v > peak) peak = v
    }
    // The floor is deliberate: a bin of true silence inside a take is
    // information (it is the gap between words), and drawing nothing there
    // would read as the take having stopped.
    const h = Math.max(1, peak * height)
    parts.push(`M${round2(start)} ${round2(mid - h / 2)}h${round2(barW)}v${round2(h)}h${round2(-barW)}z`)
  }

  return parts.join("")
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

/** Two decimals is well under a device pixel at any zoom and keeps the `d`
 *  string a third of the size it would otherwise be — this string is rebuilt
 *  for every visible chip. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
