// The lines selected on the Media timeline (AQU-2742), for the voice sidebar's
// Make speech. A tiny store rather than workspace state: only the sidebar reads
// it, so a selection change re-renders the sidebar, not the whole workspace.
import { useSyncExternalStore } from "react"

const EMPTY: readonly string[] = []
let selection: readonly string[] = EMPTY
const listeners = new Set<() => void>()

export function setTimelineSelection(cellIds: readonly string[]): void {
  const next = cellIds.length === 0 ? EMPTY : cellIds
  if (next === selection) return
  selection = next
  for (const listener of listeners) listener()
}

export function getTimelineSelection(): readonly string[] {
  return selection
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The timeline's selected lines, in file order; empty when no timeline is shown. */
export function useTimelineSelection(): readonly string[] {
  return useSyncExternalStore(subscribe, getTimelineSelection, () => EMPTY)
}
