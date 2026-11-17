// The timeline's seek commands for the linked picture.
//
// A scrub sends one several times a second. Held as workspace state, each
// re-rendered the whole workspace and, under it, every drawn column of the
// timeline. Held here, only the picture that subscribes renders.

import { useSyncExternalStore } from "react"

export interface VideoSeek {
  sec: number
  /** Bumps on every request, so a repeated second is still a new seek. */
  nonce: number
  /** AQU-1117: also start the picture once the seek lands. */
  play?: boolean
}

export interface VideoSeekStore {
  get(): VideoSeek | null
  request(sec: number, play?: boolean): void
  clear(): void
  subscribe(listener: () => void): () => void
}

export function createVideoSeekStore(): VideoSeekStore {
  let current: VideoSeek | null = null
  const listeners = new Set<() => void>()
  const set = (next: VideoSeek | null) => {
    current = next
    for (const listener of listeners) listener()
  }
  return {
    get: () => current,
    request: (sec, play) => set({ sec, nonce: (current?.nonce ?? 0) + 1, play }),
    clear: () => { if (current) set(null) },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

const noSeek = () => null
const subscribeNothing = () => () => {}

export function useVideoSeek(store: VideoSeekStore | undefined): VideoSeek | null {
  return useSyncExternalStore(store?.subscribe ?? subscribeNothing, store?.get ?? noSeek, store?.get ?? noSeek)
}
