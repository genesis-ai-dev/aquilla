/** The line a timeline reload should open on.
 *
 * `starts` are the lines that have a place on the clock, in file order.
 * The line is the last one that has already started at `sec` — the one under
 * the middle of the view. Before the first line, that first line is the
 * place: the reader is at the start of the file, and the start is a place. */

export function cellIdNearestStart(
  starts: readonly { id: string; startSec: number }[],
  sec: number,
): string | null {
  if (starts.length === 0 || !Number.isFinite(sec)) return null
  let bestId: string | null = null
  let bestStart = Number.NEGATIVE_INFINITY
  for (const s of starts) {
    if (!Number.isFinite(s.startSec) || s.startSec > sec + 1e-3) continue
    if (s.startSec >= bestStart) {
      bestStart = s.startSec
      bestId = s.id
    }
  }
  return bestId ?? starts[0]?.id ?? null
}

export interface ResumeScroll {
  /** Scroll offset to apply. */
  left: number
  /** Where the line sits relative to the left edge of the view. */
  offsetPx: number
  /** False when the line is already where the reload left it. */
  move: boolean
}

/**
 * Keep a restored line where the reload already showed it.
 *
 * The page paints the timeline at the scroll the reader left. Centering the
 * line on top of that slides the view backward. If the line is already on
 * screen, leave the scroll and remember how far the line sits from the left
 * edge. When its clock later moves — recordings arrive and the programme
 * grows — keep it at that same spot. A line that is not on screen is centered.
 */
export function resumeScrollLeft({
  atPx,
  scrollLeft,
  viewportPx,
  heldOffsetPx,
}: {
  atPx: number
  scrollLeft: number
  viewportPx: number
  heldOffsetPx: number | null
}): ResumeScroll {
  const view = Number.isFinite(viewportPx) ? Math.max(0, viewportPx) : 0
  const leftNow = Number.isFinite(scrollLeft) ? Math.max(0, scrollLeft) : 0
  const onScreen = atPx >= leftNow - 1 && atPx <= leftNow + view + 1
  if (heldOffsetPx == null && onScreen) {
    return { left: leftNow, offsetPx: atPx - leftNow, move: false }
  }
  const offset = heldOffsetPx ?? view / 2
  const left = Math.max(0, atPx - offset)
  return { left, offsetPx: offset, move: Math.abs(left - leftNow) > 1 }
}
