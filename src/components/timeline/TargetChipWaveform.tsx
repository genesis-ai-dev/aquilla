// The waveform inside a take chip. (AQU-646)
//
// SVG rather than canvas, and the reasons are all about what it lets us NOT do:
//
//   - The visible window is a `viewBox` over a path drawn across the WHOLE
//     clip, so trimming, zooming, and the SUB-48 painted-short cut are one
//     attribute string. The browser scales it. A canvas would have to redraw
//     every visible chip on every frame of a zoom glide.
//   - `fill-current` inherits the chip's own `text-*` class, which already
//     encodes take-vs-generated, light-vs-dark, and the red at-fault state — so
//     colour costs nothing. Canvas cannot inherit `currentColor` reliably,
//     which is why CellWaveform has to read a CSS custom property with
//     getComputedStyle; doing that per chip per frame is the classic layout
//     thrash.
//   - There is no effect here at all, so a scroll tick that re-renders the lane
//     writes nothing to the DOM.
//   - happy-dom's `getContext` returns null with no adapter configured, so a
//     canvas renderer ships with zero rendering tests. A path `d` is a string
//     this suite can assert.
//
// Deliberately memoised at THIS level and not on TargetAudioChip: the chip
// receives fresh object literals (`prevChip`, `snap`) and a freshly allocated
// candidates array on every render, so React.memo there can never bail out.
// Everything below is a primitive or one stable Float32Array.

import { memo, useMemo } from "react"
import { waveformPathD } from "@/lib/timeline/chip-waveform"

export interface TargetChipWaveformProps {
  /** Peaks for the whole clip, normalised so the loudest bin is 1. */
  peaks: Float32Array
  /** Visible window in BIN coordinates, from `chipWaveformWindow`. */
  x0: number
  x1: number
  /** Bins per drawn bar, from `waveformStride`. */
  stride: number
  /** The chip's height in CSS px — also the viewBox's height, so the path's y
   *  units are pixels and the 1px floor on a silent bin is exact. */
  chipH: number
}

function TargetChipWaveformImpl({ peaks, x0, x1, stride, chipH }: TargetChipWaveformProps) {
  const d = useMemo(() => waveformPathD(peaks, stride, chipH), [peaks, stride, chipH])
  const width = x1 - x0
  if (!d || !(width > 0) || !(chipH > 0)) return null

  return (
    <svg
      // Decoration: the chip's tooltip and label already say everything this
      // shows, and a screen reader has no use for a shape.
      aria-hidden
      data-testid="tl-chip-waveform"
      // `inset-0` inside the chip's existing overflow-hidden box, so a window
      // that runs past an edge is clipped rather than painting a neighbour.
      // pointer-events-none keeps the body drag and both trim handles reachable
      // through it.
      className="pointer-events-none absolute inset-0 h-full w-full fill-current opacity-40 transition-opacity group-hover/chip:opacity-70"
      viewBox={`${x0} 0 ${width} ${chipH}`}
      // The whole point: bin-space horizontally, pixels vertically, stretched
      // independently. Without this the bars would letterbox instead of filling.
      preserveAspectRatio="none"
    >
      <path d={d} />
    </svg>
  )
}

export const TargetChipWaveform = memo(TargetChipWaveformImpl)
