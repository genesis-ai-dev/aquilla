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

function notify(): void {
  for (const l of listeners) l()
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

/** Open a take in the Station; `show` also brings its tab forward. */
export function openInStation(next: StationTarget | null, opts: { show?: boolean } = {}): void {
  if (!sameTarget(target, next)) {
    target = next
    notify()
  }
  if (opts.show) for (const l of showListeners) l()
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
  available = false
  listeners.clear()
  showListeners.clear()
}
