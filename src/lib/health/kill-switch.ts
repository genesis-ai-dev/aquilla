import { useSyncExternalStore } from "react"
import { isLowMemoryActive, subscribeLowMemory } from "@/lib/perf/low-memory"

/**
 * User-controlled switch for client-side health work: decay health, rule
 * infraction checks, the confidence overlay fetch, and the per-row health
 * ribbon. These are whole-file walks that retain per-cell signatures, inputs,
 * and points, so a user on a very large file can turn them off from the
 * editor's view settings.
 *
 * On by default; the choice is per-browser (localStorage, `"0"` = off).
 *
 * AQU-1191: the *default* follows low-memory mode — on a device that mode calls
 * constrained, health work starts off, because it is the heaviest of the live
 * decorations. Only the default moves. An explicit choice is stored either way
 * (`"1"` as well as `"0"`), so a user who turned health on keeps it on however
 * the device reports itself, and one who turned it off is never re-enabled by
 * leaving low-memory mode.
 */
export const HEALTH_CALCULATIONS_STORAGE_KEY = "health-calculations"

const listeners = new Set<() => void>()

/** Cached so useSyncExternalStore's getSnapshot stays cheap and stable. */
let enabled = read()

function read(): boolean {
  try {
    const stored = localStorage.getItem(HEALTH_CALCULATIONS_STORAGE_KEY)
    if (stored === "0") return false
    if (stored === "1") return true
  } catch {
    return true
  }
  return !isLowMemoryActive()
}

// Flipping low-memory mode moves the default, so consumers re-render without a
// reload. A stored choice makes `read()` mode-independent, so this is a no-op
// for anyone who has used the health toggle.
subscribeLowMemory(() => {
  const next = read()
  if (enabled === next) return
  enabled = next
  for (const listener of listeners) listener()
})

export function isHealthCalculationsEnabled(): boolean {
  return enabled
}

export function setHealthCalculationsEnabled(next: boolean): void {
  try {
    localStorage.setItem(HEALTH_CALCULATIONS_STORAGE_KEY, next ? "1" : "0")
  } catch {
    // Private-mode / storage-disabled browsers keep the in-memory choice only.
  }
  if (enabled === next) return
  enabled = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Live read — flipping the view-settings toggle re-renders consumers. */
export function useHealthCalculationsEnabled(): boolean {
  return useSyncExternalStore(subscribe, isHealthCalculationsEnabled, () => true)
}
