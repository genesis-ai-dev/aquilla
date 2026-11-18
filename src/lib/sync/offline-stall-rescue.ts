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
 * each rescued edit is uploaded once, by one queue. A healthy leader confirms
 * within milliseconds and none of this comes into play.
 *
 * New edits can't join the set once a stall is reported: `planOfflineRouting`
 * sends them to IndexedDB instead, and its commit refuses if the stall lands
 * while it was waiting on the store.
 */

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

export function isRescuedFromOfflineQueue(id: string): boolean {
  return rescuedIds.has(id)
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
  rescueChain = rescueChain.then(() => rescueOnce(copy))
  return rescueChain
}

async function rescueOnce(copy: CopyToOutbox): Promise<boolean> {
  const entries = [...awaitingPersist]
  if (entries.length === 0) return true
  const records = entries.flatMap((entry) => entry.records)
  try {
    await copy(records)
  } catch (error) {
    console.error("[outbox] Couldn't copy unsaved offline edits to IndexedDB; they stay in the restart journal", error)
    return false
  }
  // Every copy is in IndexedDB now, including any the leader confirmed during
  // the write (their journal entries have already gone).
  for (const record of records) rescuedIds.add(record.id)
  for (const entry of entries) {
    if (!awaitingPersist.delete(entry)) continue
    entry.stopWatching()
    entry.clearJournal()
  }
  console.warn(`[outbox] Copied ${records.length} offline edit(s) the stalled store hadn't saved to IndexedDB`)
  return awaitingPersist.size === 0
}

/** Test-only reset. */
export function forgetStallRescueForTests(): void {
  for (const entry of awaitingPersist) entry.stopWatching()
  awaitingPersist.clear()
  rescuedIds.clear()
  rescueChain = Promise.resolve(true)
}
