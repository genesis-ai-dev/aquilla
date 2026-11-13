// Linked scrolling for the Bible document (AQU-2559). The two sides scroll on
// their own; the one the reader is not driving follows it, verse for verse.
//
// A translation is rarely as long as its source, so the panes cannot share a
// scroll offset. Each verse is an anchor instead: the follower is placed so
// the reader is the same fraction of the way between the same two verses.

import { useEffect, useRef, type RefObject } from "react"

interface Anchor { id: string; top: number }

/** Anchor positions, in the pane's own scroll coordinates. Sorted by `top`. */
function anchorsOf(pane: HTMLElement): Anchor[] {
  const base = pane.getBoundingClientRect().top - pane.scrollTop
  const out: Anchor[] = []
  const seen = new Set<string>()
  for (const el of pane.querySelectorAll<HTMLElement>("[data-cell-id]")) {
    const id = el.dataset.cellId
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, top: el.getBoundingClientRect().top - base })
  }
  return out
}

/** Where `driver`'s reading line is, as a verse and a fraction of the way to
 *  the next verse both panes have. */
export function followTarget(driver: readonly Anchor[], follower: readonly Anchor[], line: number): number | null {
  const tops = new Map(follower.map((a) => [a.id, a.top]))
  const shared = driver.filter((a) => tops.has(a.id))
  if (shared.length === 0) return null
  let i = 0
  while (i + 1 < shared.length && shared[i + 1].top <= line) i++
  const here = shared[i]
  const next = shared[i + 1]
  const from = tops.get(here.id) ?? 0
  if (!next || next.top <= here.top) return from + (line - here.top)
  const fraction = Math.min(1, Math.max(0, (line - here.top) / (next.top - here.top)))
  const to = tops.get(next.id) ?? from
  // Above the first shared verse the panes simply move together.
  return line < here.top ? from + (line - here.top) : from + fraction * (to - from)
}

/** How far below a pane's top edge the reading line sits. */
const READING_LINE_PX = 32

export function useLinkedScroll(panes: ReadonlyArray<RefObject<HTMLElement | null>>, enabled: boolean): void {
  const driverRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!enabled) return
    const elements = panes.map((p) => p.current).filter((el): el is HTMLElement => el !== null)
    if (elements.length < 2) return
    let frame = 0
    const cleanups: Array<() => void> = []

    const follow = (driver: HTMLElement) => {
      const driverAnchors = anchorsOf(driver)
      const line = driver.scrollTop + READING_LINE_PX
      for (const follower of elements) {
        if (follower === driver) continue
        const target = followTarget(driverAnchors, anchorsOf(follower), line)
        if (target !== null) follower.scrollTop = Math.max(0, target - READING_LINE_PX)
      }
    }

    for (const el of elements) {
      // The pane under the pointer, or holding the caret, is the one driving.
      const drive = () => {
        driverRef.current = el
      }
      const onScroll = () => {
        if (driverRef.current !== el) return
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => follow(el))
      }
      const driving: Array<keyof HTMLElementEventMap> = ["pointerenter", "pointerdown", "wheel", "touchstart", "keydown", "focusin"]
      for (const type of driving) el.addEventListener(type, drive, { passive: true })
      el.addEventListener("scroll", onScroll, { passive: true })
      cleanups.push(() => {
        for (const type of driving) el.removeEventListener(type, drive)
        el.removeEventListener("scroll", onScroll)
      })
    }
    return () => {
      cancelAnimationFrame(frame)
      for (const cleanup of cleanups) cleanup()
    }
    // The pane refs are stable; their elements exist once the view has mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, panes.length])
}
