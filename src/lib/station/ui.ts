// The Station's bits of UI state that live outside its panel (AQU-2327): its
// ⋯ menu sits in the dock strip's area menu, so History's open state, the
// row count it shows and the actions it runs are shared through here.

import { useSyncExternalStore } from "react"

export interface StationUi {
  historyOpen: boolean
  historyCount: number
  /** Set by the open Station: what its ⋯ items do (slice 9). */
  removeNoise: (() => void) | null
  changeVoice: (() => void) | null
}

let ui: StationUi = { historyOpen: false, historyCount: 0, removeNoise: null, changeVoice: null }
const listeners = new Set<() => void>()

export function setStationUi(patch: Partial<StationUi>): void {
  const next = { ...ui, ...patch }
  if ((Object.keys(patch) as Array<keyof StationUi>).every((k) => next[k] === ui[k])) return
  ui = next
  // A copy: a listener re-subscribing as it runs must not be called again.
  for (const l of [...listeners]) l()
}

export function getStationUi(): StationUi {
  return ui
}

export function useStationUi(): StationUi {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    getStationUi,
    getStationUi,
  )
}
