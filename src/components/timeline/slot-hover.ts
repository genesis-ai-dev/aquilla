// "Which empty slot is the pointer on" — the timeline's answer to a question
// CSS could not answer honestly. (AQU-646 round 9)
//
// Sam hit six mic buttons lit at once at 0.2× zoom with the pointer on none of
// them. The reveal was `group-hover/slot`, and WebKit does not re-evaluate
// `:hover` when content moves UNDER a stationary pointer — so every slot the
// pointer had passed over while the track scrolled or zoomed stayed lit until
// the mouse happened to cross it again.
//
// Lives in its own module rather than beside TimelineSlotButton so that file
// exports only its component (fast refresh) and so both lanes import the same
// hook rather than growing two copies that drift.

import { useState } from "react"

/**
 * The narrowest slot that still offers its button.
 *
 * Was 24px in three separate copies (one named constant and two literals) until
 * Sam pointed out that the rule is the 0.2-SECOND floor and this pixel gate was
 * quietly hiding most of the buttons whenever he zoomed out — which read as
 * "the record button doesn't show up on shorter sections". At 5px the 28px
 * button simply overhangs its slot and centres on it, which is what it already
 * did at 24px.
 */
export const MIN_SLOT_PX = 5

/**
 * One hot slot per lane.
 *
 * Two properties CSS `:hover` could not give us. Only ONE slot can be hot, so a
 * lane cannot light six buttons however the pointer got there. And the answer
 * is dropped whenever the track moves — `viewStartSec` changes on every scroll
 * tick, `pxPerSec` on every zoom step — because that is exactly the moment the
 * browser stops telling the truth: the slot under a stationary pointer has
 * changed, and no pointer event will say so.
 *
 * The reset is a render-phase adjustment rather than an effect. React's own
 * guidance for "reset state when a prop changes", and it avoids the cascading
 * re-render an effect would cause on every scroll tick of a lane that is
 * already re-rendering.
 *
 * The deliberate cost: scroll with the pointer parked over a slot and nothing
 * is lit until you move a pixel. Under-revealing is the right way to be wrong
 * here — over-revealing is the bug that started this.
 */
export function useHotSlot(viewStartSec: number, pxPerSec: number) {
  const [hotKey, setHotKey] = useState<string | null>(null)
  const [window, setWindow] = useState({ viewStartSec, pxPerSec })
  if (window.viewStartSec !== viewStartSec || window.pxPerSec !== pxPerSec) {
    setWindow({ viewStartSec, pxPerSec })
    setHotKey(null)
  }
  return {
    hotKey,
    /** Spread onto the slot wrapper; `key` identifies the slot within the lane. */
    slotHoverProps: (key: string) => ({
      onPointerEnter: () => setHotKey(key),
      // Guarded so a leave that arrives AFTER another slot's enter (the pointer
      // crossing a run of abutting slots) cannot blank the new one.
      onPointerLeave: () => setHotKey((cur) => (cur === key ? null : cur)),
    }),
  }
}
