// What an empty line on the Target audio track can show, by how wide it is.
// (AQU-2663, Sam, Nov 19: "This won't do for narrow... chips.")
//
// ONE RULE: what the line offers fits INSIDE the line.
//   - Room for the pair (mic + ✨, the gap, a 4px margin each side): the pair.
//   - Otherwise ONE button, inside the line, at the row's size, shrinking to
//     fit down to SLOT_BUTTON_MIN_PX. With two actions it opens a menu.
//   - Narrower than that floor: nothing at rest. On hover or keyboard focus
//     the floor-sized button is revealed, kept over the line and any EMPTY
//     space beside it, never over a neighbouring clip as drawn; with no empty
//     space beside it, it is clipped to what is free of the line.
//
// This replaces the 2026-08-14 overhang (a fixed-size button centred on a
// narrow line, sticking out over its neighbours either side).

import { SLOT_BUTTON_MIN_PX } from "./row-metrics"

/** Air between the buttons and the line's edges. */
export const SLOT_INSET_PX = 4
/** The gap between the mic and the ✨ (`gap-1`). */
export const SLOT_PAIR_GAP_PX = 4

export type EmptySlotFit =
  | { kind: "pair"; sizePx: number }
  | { kind: "one"; sizePx: number }
  | {
      kind: "reveal"
      sizePx: number
      /** The box the revealed button is drawn in, relative to the line's left
       *  edge. Equal to the button when it fits in the free space. */
      boxLeftPx: number
      boxWidthPx: number
      /** The free space is narrower than the button: the box clips it. */
      clipped: boolean
    }

export function emptySlotFit({
  lineLeftPx,
  lineWidthPx,
  buttonPx,
  actions,
  neighbours,
}: {
  lineLeftPx: number
  lineWidthPx: number
  /** The row's button size, `slotButtonPx(chipH)`. */
  buttonPx: number
  /** 2 when the line offers Record and Make speech, 1 when only one. */
  actions: 1 | 2
  /** The clips on the same track AS DRAWN (a tiny take at its painted
   *  minimum), in the same px as `lineLeftPx`. */
  neighbours: readonly { startPx: number; endPx: number }[]
}): EmptySlotFit {
  const pairNeed = 2 * buttonPx + SLOT_PAIR_GAP_PX + 2 * SLOT_INSET_PX
  if (actions === 2 && lineWidthPx >= pairNeed) return { kind: "pair", sizePx: buttonPx }
  const fitsOne = Math.min(buttonPx, Math.floor(lineWidthPx - 2 * SLOT_INSET_PX))
  if (fitsOne >= SLOT_BUTTON_MIN_PX) return { kind: "one", sizePx: fitsOne }

  const sizePx = Math.min(buttonPx, SLOT_BUTTON_MIN_PX)
  const lineRightPx = lineLeftPx + lineWidthPx
  const centre = lineLeftPx + lineWidthPx / 2
  // The empty space around the line, up to the nearest DRAWN clip each side.
  // A clip drawn into the line (a tiny take at its painted minimum) keeps that
  // part: the box is only what is free, down to nothing.
  let freeL = -Infinity
  let freeR = Infinity
  // A clip belongs to the side its middle is on, so one drawn part-way into
  // the line still leaves the other side free.
  for (const n of neighbours) {
    if ((n.startPx + n.endPx) / 2 < centre) freeL = Math.max(freeL, n.endPx)
    else freeR = Math.min(freeR, n.startPx)
  }
  if (freeR - freeL >= sizePx) {
    const left = Math.min(Math.max(centre - sizePx / 2, freeL), freeR - sizePx)
    return { kind: "reveal", sizePx, boxLeftPx: left - lineLeftPx, boxWidthPx: sizePx, clipped: false }
  }
  return { kind: "reveal", sizePx, boxLeftPx: freeL - lineLeftPx, boxWidthPx: Math.max(0, freeR - freeL), clipped: true }
}
