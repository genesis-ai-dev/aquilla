// Which term.* writes this tab has queued and the server has not yet taken.
//
// The glossary shows a change the moment it is made, over the list it last
// read. That list is re-read whenever an earlier write is acknowledged, so a
// read can arrive that holds the earlier write and not the one just made.
// Showing it would take the newest change off the screen until its own
// acknowledgement and re-read brought it back. While a project has a write in
// this set, a list that arrives is older than what the person sees and must
// not replace it.
//
// An id leaves the set when the flush that carried it reports back (applied or
// refused). The outbox itself is the backstop: a write that left the queue any
// other way (set aside after repeated failures, discarded by the person) is
// dropped here the next time the outbox changes.

import { getOutboxRecords, subscribeToOutbox } from "@/lib/sync/outbox"
import { subscribeAppliedEvents, subscribeRejected } from "@/lib/sync/outbox-flush"
import { registerSharedStateResetForTests } from "@/lib/request-coalescer"

const unsent = new Map<string, Set<string>>()
let stopListening: (() => void) | null = null

function forget(ids: Iterable<string>): void {
  for (const id of ids) {
    for (const [projectId, set] of unsent) {
      if (set.delete(id) && set.size === 0) unsent.delete(projectId)
    }
  }
  if (unsent.size === 0) {
    stopListening?.()
    stopListening = null
  }
}

async function dropWhatLeftTheOutbox(): Promise<void> {
  const tracked = [...unsent.values()].flatMap((set) => [...set])
  if (tracked.length === 0) return
  const waiting = new Set(
    (await getOutboxRecords(tracked)).filter((record) => record.status === "pending").map((record) => record.id),
  )
  forget(tracked.filter((id) => !waiting.has(id)))
}

function listen(): void {
  if (stopListening) return
  const stops = [
    subscribeAppliedEvents((frames) => forget(frames.map((frame) => frame.id))),
    subscribeRejected((entries) => forget(entries.map((entry) => entry.id))),
    subscribeToOutbox(() => {
      void dropWhatLeftTheOutbox().catch(() => {
        // The outbox could not be read; the next change to it asks again.
      })
    }),
  ]
  stopListening = () => {
    for (const stop of stops) stop()
  }
}

/** A term.* event was put in the outbox for this project. */
export function noteTermWriteQueued(projectId: string, eventId: string): void {
  let set = unsent.get(projectId)
  if (!set) {
    set = new Set()
    unsent.set(projectId, set)
  }
  set.add(eventId)
  listen()
}

/** True while a term.* write for this project is queued and unanswered. */
export function hasUnsentTermWrites(projectId: string): boolean {
  return unsent.has(projectId)
}

registerSharedStateResetForTests(() => {
  stopListening?.()
  stopListening = null
  unsent.clear()
})
