// Which recording the Station has open (AQU-2327). A tiny store, so the ways
// in — a take's ⋯ menu on the timeline, the Recording tab's take, a click on a
// take while the Station shows — can open a recording without threading a
// callback through every layer, and the workspace can bring the Station's tab
// forward when one asks to be shown.
//
// Decided Oct 22: the Station "opens on whatever audio is selected — a clip on
// the timeline, a Library entry, a line's take — never on a cell". So the
// target is a TAKE: the line that holds it, and its id.

import { useSyncExternalStore } from "react"

export interface StationTarget {
  /** The file that holds the take (a cue sibling's id for a linked take). */
  fileId: string
  /** The line that holds the take. */
  cellId: string
  audioId: string
}

let target: StationTarget | null = null
const listeners = new Set<() => void>()
const showListeners = new Set<() => void>()

// Every loop over listeners walks a copy: a listener that re-subscribes while
// it runs (an effect re-running inside a flushSync) is added back to the live
// set, and a Set's iterator visits what is added during the walk. Walking the
// set itself called the dock's "show the Station" again and again, forever,
// and froze the page on "Edit in the Station".
function notify(): void {
  for (const l of [...listeners]) l()
}

let available = false

/** The Station exists right now (the media view is on screen): the ways in
 *  that live outside it (the Recording tab's take) only show while it does. */
export function setStationAvailable(next: boolean): void {
  if (available === next) return
  available = next
  notify()
}

export function useStationAvailable(): boolean {
  return useSyncExternalStore(subscribe, () => available, () => false)
}

export function getStationTarget(): StationTarget | null {
  return target
}

export function sameTarget(a: StationTarget | null, b: StationTarget | null): boolean {
  return a === b || (a != null && b != null && a.fileId === b.fileId && a.cellId === b.cellId && a.audioId === b.audioId)
}

let message: string | null = null

/** Open a take in the Station; `show` also brings its tab forward, and
 *  `message` is said on the message line when it opens (item 3). */
export function openInStation(next: StationTarget | null, opts: { show?: boolean; message?: string } = {}): void {
  if (!sameTarget(target, next) || opts.message !== undefined) {
    target = next
    message = opts.message ?? null
    notify()
  }
  if (opts.show) for (const l of [...showListeners]) l()
}

export function useStationMessage(): string | null {
  return useSyncExternalStore(subscribe, () => message, () => null)
}

export function clearStationMessage(): void {
  if (message === null) return
  message = null
  notify()
}

/** The workspace listens, and shows the Station's tab. */
export function onStationShowRequest(fn: () => void): () => void {
  showListeners.add(fn)
  return () => {
    showListeners.delete(fn)
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function useStationTarget(): StationTarget | null {
  return useSyncExternalStore(subscribe, getStationTarget, () => null)
}

export function __resetStationTargetForTests(): void {
  target = null
  message = null
  available = false
  listeners.clear()
  showListeners.clear()
}
