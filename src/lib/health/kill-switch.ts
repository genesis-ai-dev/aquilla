import { useSyncExternalStore } from "react"

/**
 * User-controlled switch for client-side health work: decay health, rule
 * infraction checks, the confidence overlay fetch, and the per-row health
 * ribbon. These are whole-file walks that retain per-cell signatures, inputs,
 * and points, so a user on a very large file can turn them off from the
 * editor's view settings.
 *
 * On by default; the choice is per-browser (localStorage, `"0"` = off).
 */
export const HEALTH_CALCULATIONS_STORAGE_KEY = "health-calculations"

const listeners = new Set<() => void>()

/** Cached so useSyncExternalStore's getSnapshot stays cheap and stable. */
let enabled = read()

function read(): boolean {
  try {
    return localStorage.getItem(HEALTH_CALCULATIONS_STORAGE_KEY) !== "0"
  } catch {
    return true
  }
}

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
