// The "look here" pulse on an editor row: the ring a search hit, a deep link
// with `&flash=1` (the plan board's "Go to first untranslated", a verse chip)
// or a media trace draws around the row it lands on. (AQU-1493)
//
// TWO WAYS IT USED TO GO MISSING, both found on the plan board's link:
//
// 1. A CLASS IS REACT'S. The pulse was `classList.add("codex-search-flash")`
//    on the row, but the row's `className` is rendered by React — and the
//    first time that string changes (the row strip's `group/rowstrip` arrives
//    with the project's line-editing permission, a few dozen milliseconds after
//    the editor opens), React writes the whole attribute back and the pulse is
//    gone after ~30ms. Whether it survived depended on which finished first,
//    which is why it looked intermittent. An ATTRIBUTE React does not render is
//    one it never rewrites, so the pulse now lives in `data-row-flash`.
//
// 2. A FRAME IS NOT A LANDING. The old body looked for the row once, one frame
//    after asking the list to scroll. On a row far down the file the virtual
//    list has, at that point, only drawn the row at its ESTIMATED position,
//    thousands of pixels off screen, and the 1.8s animation ran out there
//    while the list was still settling. Now it waits — frame by frame, for a
//    bounded time — until the row is actually on screen, then pulses.

/** Present on a row while it pulses. Styled in index.css. */
export const ROW_FLASH_ATTR = "data-row-flash"
/** How long the pulse lasts; matches the animation in index.css. */
export const ROW_FLASH_MS = 1800
/**
 * How long to wait for the row to come on screen. A list scrolling to an
 * estimated offset settles well inside this; past it, a row that exists
 * pulses wherever it is, and one that never appeared is let go.
 */
export const ROW_FLASH_WAIT_MS = 1500

export interface RowFlashClock {
  raf: (cb: () => void) => number
  cancelRaf: (id: number) => void
  now: () => number
  setTimeout: (cb: () => void, ms: number) => number
  clearTimeout: (id: number) => void
}

const browserClock = (): RowFlashClock => ({
  raf: (cb) => window.requestAnimationFrame(() => cb()),
  cancelRaf: (id) => window.cancelAnimationFrame(id),
  now: () => performance.now(),
  setTimeout: (cb, ms) => window.setTimeout(cb, ms),
  clearTimeout: (id) => window.clearTimeout(id),
})

/**
 * Is the row inside the list's visible area?
 *
 * Measured against the list's scroll element, clamped to the window. When the
 * list itself has no size there is nothing to measure against (no layout yet,
 * or a test DOM with no layout engine), and the row counts as visible rather
 * than making every pulse wait out the full timeout.
 */
export function rowInView(row: HTMLElement, list: HTMLElement): boolean {
  const view = list.getBoundingClientRect()
  if (view.height <= 0) return true
  const r = row.getBoundingClientRect()
  if (r.height <= 0) return false
  const top = Math.max(view.top, 0)
  const bottom = Math.min(view.bottom, window.innerHeight || view.bottom)
  return r.bottom > top && r.top < bottom
}

/**
 * Pulse the row for `cellId` once it is on screen. Returns a cancel that stops
 * the wait and takes the pulse off the row, for the caller to run when another
 * pulse replaces this one or the table unmounts.
 */
export function startRowFlash(
  getList: () => HTMLElement | null,
  cellId: string,
  clock: RowFlashClock = browserClock(),
): () => void {
  const startedAt = clock.now()
  let frame: number | null = null
  let timer: number | null = null
  let flashed: HTMLElement | null = null
  let done = false

  const find = (): { row: HTMLElement | null; list: HTMLElement | null } => {
    const list = getList()
    const row = list?.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(cellId)}"]`) ?? null
    return { row, list }
  }

  const pulse = (row: HTMLElement) => {
    // Off, a reflow, then on: re-pulsing a row that is still pulsing restarts
    // the animation instead of silently doing nothing.
    row.removeAttribute(ROW_FLASH_ATTR)
    void row.offsetWidth
    row.setAttribute(ROW_FLASH_ATTR, "")
    flashed = row
    timer = clock.setTimeout(() => {
      row.removeAttribute(ROW_FLASH_ATTR)
      flashed = null
      timer = null
    }, ROW_FLASH_MS)
  }

  const tick = () => {
    frame = null
    if (done) return
    const { row, list } = find()
    if (row && list && rowInView(row, list)) {
      done = true
      pulse(row)
      return
    }
    if (clock.now() - startedAt >= ROW_FLASH_WAIT_MS) {
      done = true
      if (row) pulse(row)
      return
    }
    frame = clock.raf(tick)
  }

  // First look on the next frame: the caller has only just asked the list to
  // scroll, and nothing has been drawn for it yet.
  frame = clock.raf(tick)

  return () => {
    done = true
    if (frame != null) clock.cancelRaf(frame)
    if (timer != null) clock.clearTimeout(timer)
    flashed?.removeAttribute(ROW_FLASH_ATTR)
    frame = null
    timer = null
    flashed = null
  }
}
