/**
 * Edits committed to LiveStore's offline queue that its leader hasn't yet
 * written to disk, and what happens to them if the leader stalls.
 *
 * Until the leader confirms a commit it lives only in this page's memory, so
 * each keeps its localStorage journal entry (replayed on the next launch if
 * the page dies first). If the leader stalls (OfflineLeaderWatchdog),
 * `rescueUnpersistedOfflineWrites` copies them to the IndexedDB outbox, and
 * from then on IndexedDB owns them: the HTTP flusher stops waiting on their
 * offline-queue copies, and the offline sync adapter stops sending those, so
 * each rescued edit is uploaded once, by one queue. The adapter dequeues a
 * rescued row once IndexedDB's copy has left the outbox; until then it still
 * counts as unsynced (quit guard, update gate, catch-up). A healthy leader confirms
 * within milliseconds and none of this comes into play.
 *
 * New edits can't join the set once a stall is reported: `planOfflineRouting`
 * sends them to IndexedDB instead, and its commit refuses if the stall lands
 * while it was waiting on the store.
 */

import { isLeaderStalled, subscribeLeaderStalled } from "@/lib/offline/leader-watchdog"
import type { OutboxRecord } from "./outbox"

/** Calls back once the leader has written a commit to disk; returns a stop function. */
export type WhenPersisted = (onPersisted: () => void) => () => void

export const nothingToPersist: WhenPersisted = (onPersisted) => {
  onPersisted()
  return () => {}
}

interface AwaitingPersist {
  records: readonly OutboxRecord[]
  clearJournal: () => void
  stopWatching: () => void
}
const awaitingPersist = new Set<AwaitingPersist>()

/** Ids IndexedDB owns now. Their offline-queue copies are left alone. */
const rescuedIds = new Set<string>()

/**
 * Rescued ids whose IndexedDB copy is still being written. Not in the outbox
 * yet, so "not in the outbox" doesn't mean "uploaded": the adapter mustn't
 * dequeue them until the copy has landed (or failed and been forgotten).
 */
const copyingIds = new Set<string>()

/** True while a rescue is still writing `id`'s IndexedDB copy. */
export function isRescueCopyInFlight(id: string): boolean {
  return copyingIds.has(id)
}

export function isRescuedFromOfflineQueue(id: string): boolean {
  return rescuedIds.has(id)
}

// Anything that counts the offline queue (the outbox chip) re-counts when the
// set changes: a rescued row is counted once, as IndexedDB's.
const rescuedListeners = new Set<() => void>()

function notifyRescuedChanged(): void {
  for (const cb of rescuedListeners) cb()
}

/** Called whenever the rescued set changes; returns an unsubscribe. */
export function subscribeRescuedFromOfflineQueue(cb: () => void): () => void {
  rescuedListeners.add(cb)
  return () => {
    rescuedListeners.delete(cb)
  }
}

/** The offline queue's copies of `ids` are gone (offline sync adapter): nothing left to leave alone. */
export function forgetRescuedFromOfflineQueue(ids: Iterable<string>): void {
  let changed = false
  for (const id of ids) changed = rescuedIds.delete(id) || changed
  if (changed) notifyRescuedChanged()
}

/**
 * Marks `ids` as IndexedDB's. A rescue does this itself; the offline sync
 * adapter does it on launch for queued rows that also have an IndexedDB copy,
 * since this set doesn't survive a restart.
 */
export function markRescuedFromOfflineQueue(ids: Iterable<string>): void {
  const before = rescuedIds.size
  for (const id of ids) rescuedIds.add(id)
  if (rescuedIds.size !== before) notifyRescuedChanged()
}

/** Every id currently marked rescued, in no particular order. */
export function rescuedFromOfflineQueue(): readonly string[] {
  return [...rescuedIds]
}

/** Cheap check before scanning a queue for rescued ids. */
export function anyRescuedFromOfflineQueue(): boolean {
  return rescuedIds.size > 0
}

/**
 * Keeps `records`' journal entry until the leader has persisted their commit
 * (or a rescue has copied them to IndexedDB). Call it straight after the
 * commit, with no await in between, so a stall can't be reported in the gap.
 */
export function holdJournalUntilPersisted(
  records: readonly OutboxRecord[],
  whenPersisted: WhenPersisted,
  clearJournal: () => void,
): void {
  const entry: AwaitingPersist = { records, clearJournal, stopWatching: () => {} }
  awaitingPersist.add(entry)
  entry.stopWatching = whenPersisted(() => {
    if (awaitingPersist.delete(entry)) entry.clearJournal()
  })
}

// Backstop for a store that shut down: its commits never confirm, and their
// journal entries stay for the next launch either way.
const MAX_JOURNAL_WAIT_MS = 30_000

/**
 * Resolves once `cleared` does (a held journal entry has gone), the leader is
 * reported stalled (later writes go to IndexedDB, whose entries clear at
 * once), or `maxWaitMs` has passed. A batch split into runs waits on each
 * before journaling the next, so held entries can't pile up in localStorage.
 */
export function untilJournalClearedOrStalled(
  cleared: Promise<void>,
  maxWaitMs = MAX_JOURNAL_WAIT_MS,
): Promise<void> {
  if (isLeaderStalled()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      unsubscribe()
      clearTimeout(timer)
      resolve()
    }
    const unsubscribe = subscribeLeaderStalled(() => {
      if (isLeaderStalled()) done()
    })
    const timer = setTimeout(done, maxWaitMs)
    void cleared.then(done)
  })
}

/** Writes records to IndexedDB, leaving any id already there as it is; throws on failure. */
export type CopyToOutbox = (records: readonly OutboxRecord[]) => Promise<unknown>

// One rescue at a time: a second call waits for the first, so it can't report
// "nothing left" while the first's copy is still in flight, or fail.
let rescueChain: Promise<boolean> = Promise.resolve(true)

/**
 * Copies every edit the leader hasn't confirmed into IndexedDB. Resolves true
 * once none is left unsaved. On false nothing changed: the edits are still
 * awaited (a leader that recovers clears their journal entries as usual), their
 * journal entries stay for the next launch, and a later call tries again.
 */
export function rescueUnpersistedOfflineWrites(copy: CopyToOutbox): Promise<boolean> {
  // Never rejects: a rejection kept in the chain would fail every later rescue.
  rescueChain = rescueChain.then(() => rescueOnce(copy)).catch((error: unknown) => {
    console.error("[outbox] Offline stall rescue failed; a later call tries again", error)
    return false
  })
  return rescueChain
}

async function rescueOnce(copy: CopyToOutbox): Promise<boolean> {
  const entries = [...awaitingPersist]
  if (entries.length === 0) return true
  const records = entries.flatMap((entry) => entry.records)
  // Marked before the copy, not after: once a row lands in IndexedDB the HTTP
  // flusher may send it straight away, and the offline adapter must already
  // be leaving its queue copy alone by then. Also marked copying, so the
  // adapter doesn't take "not in the outbox yet" for "uploaded" and dequeue it.
  const marked = records.map((record) => record.id).filter((id) => !rescuedIds.has(id))
  const copying = records.map((record) => record.id).filter((id) => !copyingIds.has(id))
  markRescuedFromOfflineQueue(marked)
  for (const id of copying) copyingIds.add(id)
  try {
    await copy(records)
  } catch (error) {
    forgetRescuedFromOfflineQueue(marked)
    console.error("[outbox] Couldn't copy unsaved offline edits to IndexedDB; they stay in the restart journal", error)
    return false
  } finally {
    for (const id of copying) copyingIds.delete(id)
  }
  // Every copy is in IndexedDB now, including any the leader confirmed during
  // the write (their journal entries have already gone).
  for (const entry of entries) {
    if (!awaitingPersist.delete(entry)) continue
    try {
      entry.stopWatching()
      entry.clearJournal()
    } catch (error) {
      // The edit is in IndexedDB; a journal entry left behind only replays
      // (idempotently) on the next launch.
      console.warn("[outbox] Couldn't clear a rescued edit's journal entry", error)
    }
  }
  console.warn(`[outbox] Copied ${records.length} offline edit(s) the stalled store hadn't saved to IndexedDB`)
  return awaitingPersist.size === 0
}

/** Test-only reset. */
export function forgetStallRescueForTests(): void {
  for (const entry of awaitingPersist) entry.stopWatching()
  awaitingPersist.clear()
  rescuedIds.clear()
  copyingIds.clear()
  rescuedListeners.clear()
  rescueChain = Promise.resolve(true)
}
