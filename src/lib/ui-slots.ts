// Named DOM slots for cross-tree portals. (AQU-646)
//
// The media lens has components that RENDER content into a spot another
// component OWNS: the timeline's chip strip renders into a header row that
// lives beside the video pane, and the table's segment navigator renders into
// the strip's right edge. The old wiring found its slot with a one-shot
// `document.querySelector` in a mount effect, which only works when slot and
// content commit in the same render pass — an invariant that quietly broke the
// moment the strip itself became portaled (it now appears one commit later).
//
// So slots register themselves: the owning element's ref callback publishes the
// node here, and consumers subscribe. Whichever side mounts first, the consumer
// re-renders when its slot appears or disappears, and nothing depends on commit
// ordering.

import { useSyncExternalStore } from "react"

const slots = new Map<string, HTMLElement>()
const listeners = new Set<() => void>()
/** Ref callbacks must be REFERENTIALLY STABLE or React re-invokes them (null,
 *  then the node) on every render, unmounting the portal each time. One
 *  callback per name, forever. */
const refCallbacks = new Map<string, (el: HTMLElement | null) => void>()

function notify(): void {
  for (const l of listeners) l()
}

export function setUiSlot(name: string, el: HTMLElement | null): void {
  if (el == null) {
    if (!slots.has(name)) return
    slots.delete(name)
  } else {
    if (slots.get(name) === el) return
    slots.set(name, el)
  }
  notify()
}

/** A stable ref callback that registers the element as `name`. */
export function uiSlotRef(name: string): (el: HTMLElement | null) => void {
  let cb = refCallbacks.get(name)
  if (!cb) {
    cb = (el) => setUiSlot(name, el)
    refCallbacks.set(name, cb)
  }
  return cb
}

/** Subscribe to a slot's element. Null until it mounts (and after it leaves). */
export function useUiSlot(name: string): HTMLElement | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => slots.get(name) ?? null,
    () => null,
  )
}

export function resetUiSlotsForTests(): void {
  slots.clear()
  notify()
}
