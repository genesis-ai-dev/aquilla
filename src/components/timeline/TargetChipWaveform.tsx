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
import type { CSSProperties } from "react"
import { cn } from "@/lib/utils"
import { waveformPathD } from "@/lib/timeline/chip-waveform"
import { TRACK_WAVE_FILL_CLASS, WAVE_LOOK } from "@/lib/timeline/track-colors"

export interface TargetChipWaveformProps {
  /** Peaks for the whole clip, normalised so the loudest bin is 1. */
  peaks: Float32Array
  /** Visible window in BIN coordinates, from `chipWaveformWindow`. */
  x0: number
  x1: number
  /** The chip's height in CSS px — also the viewBox's height, so the path's y
   *  units are pixels and the 1px floor on a silent bin is exact. */
  chipH: number
  /**
   * AQU-2235: the name bar's height. The waveform is drawn in the height
   * UNDER it — `drawH` px tall, starting `topPx` down — and never behind it.
   * Absent (no bar: a short row, or this lane's own tests) it fills the chip.
   */
  topPx?: number
  drawH?: number
  /** The take's own preview is playing: the part played is drawn at full
   *  strength and the rest at 30%, split at the chip's `--tl-play-x`. */
  playing?: boolean
  /** The chip is the red one at fault in an overlap: the waveform keeps the
   *  alarm's colour (the chip's own text colour), as it always has. */
  fault?: boolean
}

function TargetChipWaveformImpl({ peaks, x0, x1, chipH, topPx = 0, drawH, playing = false, fault = false }: TargetChipWaveformProps) {
  // No zoom term in these deps, and that is the envelope's whole advantage over
  // the bars it replaced: the shape is stretched by the viewBox, so it is
  // rebuilt only when the audio or the row height changes — never during a
  // zoom glide.
  const h = drawH ?? chipH
  const d = useMemo(() => waveformPathD(peaks, h), [peaks, h])
  const width = x1 - x0
  if (!d || !(width > 0) || !(h > 0)) return null

  // AQU-2235 (Sam, Oct 25, board 51): the track's deep shade at 90%, steady —
  // the old 40% ink lifted to 70% on hover; this needs no lift. Under a bar it
  // sits below the bar; with none it fills the chip as it always did.
  const box: CSSProperties = drawH != null ? { top: topPx, height: drawH } : {}
  const fill = fault ? "fill-current" : TRACK_WAVE_FILL_CLASS
  const base = cn(
    "pointer-events-none absolute w-full",
    drawH != null ? "left-0" : "inset-0 h-full",
    fill,
  )
  const view = `${x0} 0 ${width} ${h}`
  const opacity = fault ? 0.4 : WAVE_LOOK.wave
  if (playing && !fault) {
    return (
      <>
        <svg
          aria-hidden
          data-testid="tl-chip-waveform"
          data-played=""
          className={base}
          style={{ ...box, opacity, clipPath: "inset(0 calc(100% - var(--tl-play-x, 0px)) 0 0)" }}
          viewBox={view}
          preserveAspectRatio="none"
        >
          <path d={d} />
        </svg>
        <svg
          aria-hidden
          data-testid="tl-chip-waveform-unplayed"
          className={base}
          style={{ ...box, opacity: WAVE_LOOK.unplayed, clipPath: "inset(0 0 0 var(--tl-play-x, 0px))" }}
          viewBox={view}
          preserveAspectRatio="none"
        >
          <path d={d} />
        </svg>
      </>
    )
  }

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
      className={base}
      style={{ ...box, opacity }}
      viewBox={view}
      // The whole point: bin-space horizontally, pixels vertically, stretched
      // independently. Without this the bars would letterbox instead of filling.
      preserveAspectRatio="none"
    >
      <path d={d} />
    </svg>
  )
}

export const TargetChipWaveform = memo(TargetChipWaveformImpl)
