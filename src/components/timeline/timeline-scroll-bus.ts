import { createContext } from "react"

/** Horizontal scroll, published without re-rendering the timeline.
 *
 *  The track column's scroll handler used to put `scrollLeft` in React state,
 *  and every wheel tick re-rendered the whole editor. The ruler and the
 *  film-length gap label are the only things that have to follow the offset
 *  on their own; everything else is a fixed time column. */
export interface TimelineScrollSnap {
  left: number
  viewport: number
}

export interface TimelineScrollBus {
  getSnap: () => TimelineScrollSnap
  getLeft: () => number
  set: (left: number, viewport: number) => void
  subscribe: (listener: () => void) => () => void
}

export function createTimelineScrollBus(): TimelineScrollBus {
  let snap: TimelineScrollSnap = { left: 0, viewport: 0 }
  const listeners = new Set<() => void>()
  return {
    getSnap: () => snap,
    getLeft: () => snap.left,
    set(left, viewport) {
      if (left === snap.left && viewport === snap.viewport) return
      snap = { left, viewport }
      listeners.forEach((listener) => listener())
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const TimelineScrollBusContext = createContext<TimelineScrollBus | null>(null)

const EMPTY_SNAP: TimelineScrollSnap = { left: 0, viewport: 0 }

export function subscribeNoScroll(listener: () => void): () => void {
  void listener
  return () => {}
}

export function emptyScrollSnap(): TimelineScrollSnap {
  return EMPTY_SNAP
}

export function emptyScrollLeft(): number {
  return 0
}
