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

import { envelopePath, envelopePoints } from "@/lib/audio/waveform-shape"
import type { TargetChipGeom } from "./lane-timing"

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
 * The `d` of one `<path>` covering the WHOLE clip: bin coordinates
 * horizontally, CSS pixels vertically.
 *
 * A filled envelope, not bars (Sam, 2026-08-22 — bars made the trim handles
 * blend into the chip). The shape itself lives in lib/audio/waveform-shape so
 * the Recording tab's canvas draws the identical figure from the identical
 * peaks; this wrapper only supplies the timeline's geometry.
 *
 * The y unit is pixels so the caller can set the viewBox height to the chip
 * height and have the 1px floor on a silent bin come out exact.
 *
 * NOTE what is NOT an argument any more: there is no stride. The envelope is
 * one polyline the viewBox stretches to any width, so this path does not depend
 * on zoom and is rebuilt only when the peaks or the row height change.
 */
export function waveformPathD(peaks: Float32Array, chipH: number): string {
  if (!Number.isFinite(chipH) || chipH <= 0) return ""
  return envelopePath(envelopePoints(peaks, chipH), chipH / 2)
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}
