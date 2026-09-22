// The time ruler. Renders "nice"-spaced ticks with monospaced labels and turns
// a click into a seek (onScrub, seconds). Width tracks the zoomed duration.
//
// 2026-08-11: two standing fixes, neither caused by the source-audio band but
// both made worse by it.
//   - The duration is CLAMPED. A media element that has not reported yet gives
//     `durationSec` as NaN or Infinity, and `width: Infinitypx` silently kills
//     the whole track — no ruler, no lanes, no playhead.
//   - The tick loop is WINDOWED. Every tick is a positioned div carrying a
//     label; a 70-minute file at the default zoom asks for ~2,100 of them on
//     every render, and the lanes beside it have windowed since SUB-18.
// Both callers-optional: with no window the output is byte-identical to before.

import { memo } from "react"
import { useScrubGesture } from "./useScrubGesture"
import { secToPx, pxToSec } from "@/lib/timeline/scale"
import { fmtClock, niceTickSec } from "./format"

export interface TimelineRulerProps {
  durationSec: number
  pxPerSec: number
  /** Visible window in track seconds. Omitted = draw every tick. */
  viewStartSec?: number
  viewEndSec?: number
  onScrub(sec: number): void
  /** AQU-646 stage 5: the drag became real — take the transport. Fires once,
   *  past the intent threshold, never on a plain click. */
  onScrubStart?(): void
  /** The pointer moved during a drag, coalesced to one call per frame. */
  onScrubMove?(sec: number): void
  /** Released (or cancelled). The caller lands this through its ordinary seek. */
  onScrubEnd?(sec: number): void
}

function TimelineRulerImpl({
  durationSec,
  pxPerSec,
  viewStartSec,
  viewEndSec,
  onScrub,
  onScrubStart,
  onScrubMove,
  onScrubEnd,
}: TimelineRulerProps) {
  const step = niceTickSec(pxPerSec)
  // Non-finite/negative means "not reported yet" — fall back to a one-step
  // track rather than an infinitely wide one.
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  const spanSec = Math.max(safeDuration, step)
  const from = Number.isFinite(viewStartSec) ? Math.max(0, viewStartSec as number) : 0
  const to = Number.isFinite(viewEndSec) ? Math.min(spanSec, viewEndSec as number) : spanSec
  const ticks: number[] = []
  // Snap the first tick DOWN onto the step grid: a label must sit at the same
  // absolute second whatever the window happens to start at, or the numbers
  // slide around as you scroll.
  for (let t = Math.floor(from / step) * step; t <= to; t += step) ticks.push(t)
  const width = secToPx(spanSec, pxPerSec)

  // AQU-646 stage 5: this band is a scrub surface now, as well as a place to
  // click. `onScrubMove` absent means no drag is wanted at all, which is what
  // every existing caller and every existing test gets.
  const scrub = useScrubGesture({
    pxPerSec,
    durationSec: spanSec,
    onScrubStart,
    onScrubMove: onScrubMove ?? (() => {}),
    onScrubEnd,
    disabled: !onScrubMove,
  })

  return (
    <div
      data-testid="tl-ruler"
      // AQU-646 stage 3: the ruler stays put while the track stack scrolls
      // under it, and that turns its background into a correctness problem.
      //
      //   OPACITY. `bg-muted/30` is 30% — it only ever looked solid because
      //   nothing passed behind it. With chips scrolling underneath they would
      //   be plainly visible THROUGH the ruler, tick labels and all. So the
      //   opaque `bg-background` (what the card behind it paints) carries the
      //   composite and the 30% tint moves to an inset pseudo-element, which
      //   reproduces today's two layers in today's order. A pseudo-element and
      //   not a child div because TimelineRuler.test.tsx counts this element's
      //   children to assert the tick window — an extra child would break three
      //   assertions that have nothing to do with backgrounds. It reaches one
      //   pixel PAST the padding box on purpose: in dark mode `--border` is 10%
      //   white, so the bottom border is translucent and needs the same tint
      //   under it or the seam reads a shade off.
      //
      //   z-20, NOT z-30. It must beat the lanes and a selected chip, and it
      //   must LOSE to two things drawn at the same level later in the DOM: the
      //   playhead (at z-30 its triangle would vanish and its line would be cut
      //   for the ruler's 28px) and a card being dragged, whose millisecond
      //   readout is anchored above the chip and so renders inside the ruler
      //   band for anything in the first lane.
      //
      // relative -> sticky is safe: sticky is still "positioned", so the
      // absolutely positioned ticks below keep this element as their
      // containing block.
      className="sticky top-0 z-20 h-7 cursor-col-resize touch-none select-none border-b border-border bg-background before:absolute before:inset-x-0 before:top-0 before:-bottom-px before:bg-muted/30"
      style={{ width: `${width}px` }}
      onPointerDown={scrub.onPointerDown}
      onClick={(e) => {
        // The browser fires `click` after a drag as well, and seeking twice
        // would fight the landing seek the drag already issued.
        if (scrub.consumeDragClick()) return
        const rect = e.currentTarget.getBoundingClientRect()
        onScrub(pxToSec(e.clientX - rect.left, pxPerSec))
      }}
    >
      {ticks.map((t) => (
        <div
          key={t}
          className="absolute inset-y-0 border-l border-border/70"
          style={{ left: `${secToPx(t, pxPerSec)}px` }}
        >
          <span className="absolute left-1 top-1 font-mono text-[10px] tabular-nums text-muted-foreground">
            {fmtClock(t)}
          </span>
        </div>
      ))}
    </div>
  )
}

export const TimelineRuler = memo(TimelineRulerImpl)
