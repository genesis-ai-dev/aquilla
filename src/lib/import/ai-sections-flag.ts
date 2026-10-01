// Kill switch for AI section milestones (AQU-1387).
//
// Mirrors src/lib/health/kill-switch.ts and AQU-1386's meaning-unit switch —
// same storage shape, same useSyncExternalStore wiring, same "a browser with
// storage disabled keeps the in-memory choice" behaviour.
//
// It defaults to OFF, for the same reason AQU-1386's does: the ticket makes the
// eval ("Eval script and results are in the PR. Behind a flag, with a kill
// switch") a precondition for changing what a translator sees, and the eval's
// model half cannot run without a Jev key. Until it has, every file keeps its
// Part N / 5-minute divisions.
//
// Flipping the default is a one-line change here, made in the PR that posts the
// eval numbers — not a config toggle somewhere a reviewer cannot see.
//
// The switch gates only the MILESTONE layer, which replaces what a translator
// navigates by. Suggested passages (`./passages.ts`) are additive — a new
// optional list beside the existing divisions — so a caller that shows them
// opts in by calling for them at all.

import { useSyncExternalStore } from "react"

export const AI_SECTION_MILESTONES_STORAGE_KEY = "ai-section-milestones"

/** Off until the eval clears. See the file header. */
const DEFAULT_ENABLED = false

const listeners = new Set<() => void>()

/** Cached so useSyncExternalStore's getSnapshot stays cheap and stable. */
let enabled = read()

function read(): boolean {
  try {
    const raw = localStorage.getItem(AI_SECTION_MILESTONES_STORAGE_KEY)
    if (raw === null) return DEFAULT_ENABLED
    return raw === "1"
  } catch {
    return DEFAULT_ENABLED
  }
}

export function areAiSectionMilestonesEnabled(): boolean {
  return enabled
}

export function setAiSectionMilestonesEnabled(next: boolean): void {
  try {
    localStorage.setItem(AI_SECTION_MILESTONES_STORAGE_KEY, next ? "1" : "0")
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

/** Live read — flipping the switch re-renders the navigator. */
export function useAiSectionMilestonesEnabled(): boolean {
  return useSyncExternalStore(subscribe, areAiSectionMilestonesEnabled, () => DEFAULT_ENABLED)
}
