/**
 * Tracks cells with an unresolved offline sync conflict — a locally queued
 * write (Phase 4's LiveStore `event_queue`) that the server rejected as a
 * stale sibling (AD-2 head CAS). Purely client-side UI state: LiveStore's
 * `cells` table already holds the server's winning value once the WS/flush
 * lands it, so this module only remembers WHICH cells need a "someone else
 * changed this" badge until the user dismisses it. Mirrors the
 * subscribeToOutbox listener pattern in src/lib/sync/outbox.ts.
 *
 * Keys are the same composite id `cellRowId()` (schema.ts) produces, so
 * callers can check a conflict against the exact row they're rendering
 * without re-deriving the key format.
 */
import { useSyncExternalStore } from "react"

// A fresh Set on every mutation, never mutated in place: useSyncExternalStore
// decides whether to re-render by Object.is-comparing the last snapshot to
// the next one, so reusing the same Set reference across an add()/delete()
// would report "unchanged" and silently stop re-rendering subscribers.
let conflicts: ReadonlySet<string> = new Set()
type Listener = () => void
const listeners = new Set<Listener>()

function notify(): void {
  for (const cb of listeners) cb()
}

/** Mark a cell row as conflicted. Idempotent. */
export function markConflict(cellRowKey: string): void {
  if (conflicts.has(cellRowKey)) return
  conflicts = new Set(conflicts).add(cellRowKey)
  notify()
}

/**
 * Clear one conflict. Called by the user's explicit "Dismiss" affordance —
 * the sync adapter deliberately never auto-clears a conflict on its own
 * (an unrelated remote edit to the same cell must not silently swallow the
 * fact that the user's own write lost); per the design, the user reviews
 * and manually re-applies before dismissing.
 */
export function dismissConflict(cellRowKey: string): void {
  if (!conflicts.has(cellRowKey)) return
  const next = new Set(conflicts)
  next.delete(cellRowKey)
  conflicts = next
  notify()
}

/** Clear every tracked conflict at once — the toast's single "Dismiss" acts
 *  on the whole set it summarized, not one cell at a time. */
export function dismissAllConflicts(): void {
  if (conflicts.size === 0) return
  conflicts = new Set()
  notify()
}

export function getConflicts(): ReadonlySet<string> {
  return conflicts
}

export function subscribeConflicts(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** React binding — the live conflict set, re-rendering on any change. */
export function useConflicts(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeConflicts, getConflicts, getConflicts)
}

/** Test-only reset. */
export function __resetConflictsForTests(): void {
  conflicts = new Set()
  listeners.clear()
}
