// A piece of the workspace's state kept OUT of ProjectWorkspace's own state
// (AQU-2654: the structure ratchet caps its useState calls), in a small store
// read through a hook, as the document preview's open flag is
// (lib/document-preview/open-state.ts).
//
// It behaves as the useState it replaces: one value, set by value or by
// updater, and `reset` puts it back to its first value. The workspace resets
// its slots when it unmounts, so a new workspace starts where a new useState
// would have.

import { useSyncExternalStore } from "react"

export interface WorkspaceSlot<T> {
  get(): T
  set(next: T | ((prev: T) => T)): void
  reset(): void
  subscribe(listener: () => void): () => void
}

export function workspaceSlot<T>(initial: T): WorkspaceSlot<T> {
  let value = initial
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === "function" ? (next as (prev: T) => T)(value) : next
      if (Object.is(resolved, value)) return
      value = resolved
      notify()
    },
    reset() {
      if (Object.is(value, initial)) return
      value = initial
      notify()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** The slot's value, and its setter (stable: the slot's own `set`). */
export function useWorkspaceSlot<T>(slot: WorkspaceSlot<T>): readonly [T, WorkspaceSlot<T>["set"]] {
  const value = useSyncExternalStore(slot.subscribe, slot.get, slot.get)
  return [value, slot.set] as const
}
