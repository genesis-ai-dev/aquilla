// Kill switch for meaning-unit drafting (AQU-1386).
//
// Mirrors src/lib/health/kill-switch.ts — same storage shape, same
// useSyncExternalStore wiring, same "a browser with storage disabled keeps the
// in-memory choice" behaviour.
//
// The ONE difference, and it is deliberate: this defaults to OFF.
// AQU-1386 §5 makes the shadow eval a precondition for enabling grouping
// ("behind a flag, default-on only after the eval clears"), and the eval in
// scripts/seam-eval.ts has not been run against the EBL files yet. Until it
// has, every drafting path keeps today's fixed-size chunking.
//
// Flipping the default is a one-line change here, made in the PR that posts the
// eval numbers — not a config toggle somewhere a reviewer cannot see.

import { useSyncExternalStore } from "react"

export const MEANING_UNIT_DRAFTING_STORAGE_KEY = "meaning-unit-drafting"

/** Off until the shadow eval clears. See the file header. */
const DEFAULT_ENABLED = false

const listeners = new Set<() => void>()

/** Cached so useSyncExternalStore's getSnapshot stays cheap and stable. */
let enabled = read()

function read(): boolean {
  try {
    const raw = localStorage.getItem(MEANING_UNIT_DRAFTING_STORAGE_KEY)
    if (raw === null) return DEFAULT_ENABLED
    return raw === "1"
  } catch {
    return DEFAULT_ENABLED
  }
}

export function isMeaningUnitDraftingEnabled(): boolean {
  return enabled
}

export function setMeaningUnitDraftingEnabled(next: boolean): void {
  try {
    localStorage.setItem(MEANING_UNIT_DRAFTING_STORAGE_KEY, next ? "1" : "0")
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

/** Live read — flipping the switch re-renders consumers. */
export function useMeaningUnitDraftingEnabled(): boolean {
  return useSyncExternalStore(subscribe, isMeaningUnitDraftingEnabled, () => DEFAULT_ENABLED)
}
