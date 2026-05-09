/**
 * Tiny in-process pub/sub for local-store mutations. Repo functions
 * (upsertCell, upsertThread, etc.) emit typed events after their SQL
 * completes, and React hooks like `useCellsLocal` subscribe to keep
 * derived state in sync without polling.
 *
 * The bus is global per-process — there's only one OPFS database open
 * per project at a time. If we ever need multi-store isolation, swap
 * for a per-LocalStore instance bus.
 *
 * Transactional caveat: events are fired immediately after each `run`,
 * not at COMMIT time. A rolled-back transaction therefore leaves
 * subscribers transiently stale until the next successful write. This
 * is acceptable for the prototype; a queue-and-flush-on-commit version
 * is straightforward later if it matters.
 */

export type StoreEvent =
  | { type: "cells.changed"; cellIds?: string[]; projectId?: string }
  | { type: "threads.changed"; cellId?: string }
  | { type: "thread_messages.changed"; threadId?: string }
  | { type: "waivers.changed"; cellId?: string }
  | { type: "backtranslations.changed"; cellId?: string }
  | { type: "outbox.changed"; projectId?: string }
  | { type: "project_meta.changed"; projectId?: string }

export type StoreEventListener = (event: StoreEvent) => void

class StoreEventBus {
  private listeners = new Set<StoreEventListener>()

  subscribe(listener: StoreEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: StoreEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Swallow listener errors so siblings still hear.
      }
    }
  }

  /** Test helper: drop all subscribers between cases. */
  reset(): void {
    this.listeners.clear()
  }
}

export const storeEvents = new StoreEventBus()
