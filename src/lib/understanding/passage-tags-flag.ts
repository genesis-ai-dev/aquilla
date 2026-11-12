// Kill switch for document-understanding tags (AQU-657, slice 1).
//
// Mirrors src/lib/completion/seams-flag.ts and src/lib/import/ai-sections-flag.ts
// — same storage shape, same useSyncExternalStore wiring, same "a browser with
// storage disabled keeps the in-memory choice" behaviour.
//
// It defaults to OFF, for the same reason both of those do: AQU-657 says to ship
// each slice "behind a flag, with a shadow eval", and the eval's model half
// cannot run without a Jev key. Until `pnpm tags:eval` has been run against a
// labelled fixture WITH model answers, nothing spends a call on tagging — the
// lexical heuristic in ./passage-tags.ts is what a caller gets, and it needs no
// network at all.
//
// Flipping the default is a one-line change here, made in the PR that posts the
// eval numbers — not a config toggle somewhere a reviewer cannot see.

import { useSyncExternalStore } from "react"

export const PASSAGE_TAGS_STORAGE_KEY = "passage-understanding-tags"

/** Off until the shadow eval clears. See the file header. */
const DEFAULT_ENABLED = false

const listeners = new Set<() => void>()

/** Cached so useSyncExternalStore's getSnapshot stays cheap and stable. */
let enabled = read()

function read(): boolean {
  try {
    const raw = localStorage.getItem(PASSAGE_TAGS_STORAGE_KEY)
    if (raw === null) return DEFAULT_ENABLED
    return raw === "1"
  } catch {
    return DEFAULT_ENABLED
  }
}

export function arePassageTagsEnabled(): boolean {
  return enabled
}

export function setPassageTagsEnabled(next: boolean): void {
  try {
    localStorage.setItem(PASSAGE_TAGS_STORAGE_KEY, next ? "1" : "0")
  } catch {
    // Private-mode / storage-disabled browsers keep the in-memory choice only.
  }
  if (enabled === next) return
  enabled = next
  for (const listener of listeners) listener()
}

/** Live read — flipping the switch re-renders whatever reads the tree. */
export function usePassageTagsEnabled(): boolean {
  return useSyncExternalStore(subscribe, arePassageTagsEnabled, () => DEFAULT_ENABLED)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
