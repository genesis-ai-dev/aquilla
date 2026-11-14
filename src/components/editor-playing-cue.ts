// AQU-1118: which row of the text table is playing.
//
// It changes on every line of playback. As a prop of the table it rebuilt the
// row renderer, and the table drew itself and every mounted row again at each
// line — a long task that stalled the timeline's playhead too. Read from here,
// a change re-renders the row that stopped and the row that started.

import { createContext, useContext, useSyncExternalStore } from "react"

export interface PlayingCueStore {
  get(): string | null
  set(cellId: string | null): void
  subscribe(listener: () => void): () => void
}

export function createPlayingCueStore(): PlayingCueStore {
  let current: string | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set(cellId) {
      if (cellId === current) return
      current = cellId
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export const PlayingCueContext = createContext<PlayingCueStore | null>(null)

const NO_CUE: PlayingCueStore = createPlayingCueStore()

/** Whether this row is the one playing. A selector over the store, so a line
 *  change re-renders only the two rows it moves between. */
export function useIsPlayingCue(cellId: string): boolean {
  const store = useContext(PlayingCueContext) ?? NO_CUE
  const read = () => store.get() === cellId
  return useSyncExternalStore(store.subscribe, read, read)
}
