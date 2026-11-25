// Detects a dead or wedged LiveStore leader worker. The client session boots
// straight from the persisted OPFS state db (LiveStore's "fast path"), so a
// leader that never comes up — or dies later — is invisible: reads keep
// working, `store.commit()` keeps succeeding, and every write silently piles
// up in memory, lost on the next restart. A healthy leader acks a push within
// milliseconds, so pending writes with no upstream progress for several
// seconds means nothing is persisting them.
//
// Polls rather than subscribing: a dead leader produces no sync-status
// changes, which is exactly the condition to detect.
import { useSyncExternalStore } from "react"
import type { Store, SyncStatus } from "@livestore/livestore"
import { EventSequenceNumber } from "@livestore/common/schema"
import type { schema } from "./schema"

// App-wide "leader is stalled" flag, set by OfflineLeaderWatchdog and read by
// any UI that would otherwise claim changes are saved (the outbox chip).
// Mirrors the listener pattern in ./conflicts.ts.
let leaderStalled = false
const stallListeners = new Set<() => void>()

export function setLeaderStalled(stalled: boolean): void {
  if (leaderStalled === stalled) return
  leaderStalled = stalled
  for (const cb of stallListeners) cb()
}

export function isLeaderStalled(): boolean {
  return leaderStalled
}

export function subscribeLeaderStalled(cb: () => void): () => void {
  stallListeners.add(cb)
  return () => {
    stallListeners.delete(cb)
  }
}

/** React binding — true while the offline store's leader has stopped persisting writes. */
export function useLeaderStalled(): boolean {
  return useSyncExternalStore(subscribeLeaderStalled, isLeaderStalled, isLeaderStalled)
}

/** Test-only reset. */
export function __resetLeaderStalledForTests(): void {
  leaderStalled = false
  stallListeners.clear()
}

export type LeaderStall = {
  pendingCount: number
  upstreamHead: string
  localHead: string
  stalledForMs: number
}

export type LeaderWatchdogOptions = {
  /** No upstream progress for this long, with writes pending, counts as a stall. */
  stallMs?: number
  checkEveryMs?: number
  onStall: (stall: LeaderStall) => void
  /** Fires once the leader catches up after a reported stall. */
  onRecover?: () => void
  now?: () => number
}

/** LiveStore's own parser for its e{global}[.{client}][r{rebase}] strings; null if unreadable. */
function parseSeqNum(seqNum: string): EventSequenceNumber.Client.Composite | null {
  try {
    return EventSequenceNumber.Client.fromString(seqNum)
  } catch {
    return null
  }
}

/**
 * True once `upstreamHead` (what the leader has confirmed) has reached `head`,
 * comparing global then client sequence numbers. Only meaningful while `head`
 * is from the session's current rebase generation: a rebase renumbers the
 * session's pending events, so an older head may now name another session's
 * event (`watchLeaderPersisted` moves its waiters on when that happens). An
 * unreadable head counts as not persisted: the caller keeps its backup.
 */
export function leaderHasPersisted(upstreamHead: string, head: string): boolean {
  const upstream = parseSeqNum(upstreamHead)
  const target = parseSeqNum(head)
  if (!upstream || !target) return false
  return EventSequenceNumber.Client.isGreaterThanOrEqual(upstream, target)
}

type SyncStatusFeed = Pick<Store<typeof schema>, "syncStatus" | "subscribeSyncStatus">
type PersistStatus = Pick<SyncStatus, "localHead" | "upstreamHead" | "isSynced">

interface PersistWaiter {
  /** The session's `localHead` just after the commit: the commit or later. */
  head: string
  onPersisted: () => void
}

/**
 * Every commit waiting on one store's leader, oldest first, behind ONE
 * sync-status subscription. Heads only grow along the queue (commits are
 * sequential, and a rebase moves every waiter to the same new head), so a
 * status change settles waiters from the front and stops at the first that's
 * still unpersisted.
 */
interface PersistQueue {
  waiters: PersistWaiter[]
  unsubscribe: (() => void) | null
}
const persistQueues = new WeakMap<SyncStatusFeed, PersistQueue>()

function settlePersisted(store: SyncStatusFeed, queue: PersistQueue, status: PersistStatus): void {
  // LiveStore's unsubscribe interrupts its fiber asynchronously, so a retired
  // queue's feed can still deliver a status after a new queue took its place.
  // A retired queue has no waiters left; it must not touch the new one.
  if (persistQueues.get(store) !== queue) return
  const local = parseSeqNum(String(status.localHead))
  // A rebase renumbered this session's pending events: the old heads may now
  // name another session's events. Wait for the new head instead, which is
  // at or past every renumbered commit (later than needed, never earlier).
  if (local) {
    for (const waiter of queue.waiters) {
      if (parseSeqNum(waiter.head)?.rebaseGeneration !== local.rebaseGeneration) waiter.head = String(status.localHead)
    }
  }
  const upstreamHead = String(status.upstreamHead)
  const settled: PersistWaiter[] = []
  while (queue.waiters.length > 0 && (status.isSynced || leaderHasPersisted(upstreamHead, queue.waiters[0].head))) {
    settled.push(queue.waiters.shift()!)
  }
  if (queue.waiters.length === 0) stopPersistFeed(store, queue)
  // Each on its own: this runs inside LiveStore's status subscription, and
  // one throwing callback mustn't strand the waiters after it (already off
  // the queue) or take the subscription down.
  for (const waiter of settled) {
    try {
      waiter.onPersisted()
    } catch (error) {
      console.warn("[offline] A persisted-commit callback failed", error)
    }
  }
}

function stopPersistFeed(store: SyncStatusFeed, queue: PersistQueue): void {
  queue.unsubscribe?.()
  queue.unsubscribe = null
  if (persistQueues.get(store) === queue) persistQueues.delete(store)
}

/**
 * Calls `onPersisted` once the leader has persisted the commit that left the
 * session at `head` (its `localHead` right after committing); returns a
 * function that stops waiting. A dead leader never calls back, and neither
 * does a store that has shut down — the stall watchdog covers that.
 */
export function watchLeaderPersisted(store: SyncStatusFeed, head: string, onPersisted: () => void): () => void {
  const waiter: PersistWaiter = { head, onPersisted }
  let queue = persistQueues.get(store)
  try {
    if (!queue) {
      const fresh: PersistQueue = { waiters: [waiter], unsubscribe: null }
      persistQueues.set(store, fresh)
      queue = fresh
      settlePersisted(store, fresh, store.syncStatus())
      if (fresh.waiters.length > 0) {
        const unsubscribe = store.subscribeSyncStatus((status) => settlePersisted(store, fresh, status))
        // The subscription may have settled everything as it started.
        if (persistQueues.get(store) === fresh) fresh.unsubscribe = unsubscribe
        else unsubscribe()
      }
    } else {
      queue.waiters.push(waiter)
      settlePersisted(store, queue, store.syncStatus())
    }
  } catch (error) {
    // A store that shut down can't confirm anything; the caller's backup stays.
    console.warn("[offline] Couldn't watch the leader persist a commit", error)
    stopWaiting(store, waiter)
    return () => {}
  }
  return () => stopWaiting(store, waiter)
}

function stopWaiting(store: SyncStatusFeed, waiter: PersistWaiter): void {
  const queue = persistQueues.get(store)
  if (!queue) return
  const at = queue.waiters.indexOf(waiter)
  if (at >= 0) queue.waiters.splice(at, 1)
  if (queue.waiters.length === 0) stopPersistFeed(store, queue)
}

const DEFAULT_STALL_MS = 15_000
const DEFAULT_CHECK_EVERY_MS = 2_000

type SyncStatusSource = Pick<Store<typeof schema>, "syncStatus">

/** Starts watching `store`; returns a function that stops the watchdog. */
export function watchLeaderLiveness(store: SyncStatusSource, options: LeaderWatchdogOptions): () => void {
  const { onStall, onRecover } = options
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS
  const checkEveryMs = options.checkEveryMs ?? DEFAULT_CHECK_EVERY_MS
  const now = options.now ?? Date.now

  let stalledSince: number | undefined
  let lastUpstreamHead: string | undefined
  let reported = false

  const check = () => {
    const status = store.syncStatus()
    const upstreamHead = String(status.upstreamHead)

    if (status.isSynced) {
      stalledSince = undefined
      lastUpstreamHead = upstreamHead
      if (reported) {
        reported = false
        onRecover?.()
      }
      return
    }

    // Any upstream progress means the leader is alive, just busy.
    if (upstreamHead !== lastUpstreamHead) {
      lastUpstreamHead = upstreamHead
      stalledSince = now()
      return
    }

    stalledSince ??= now()
    const stalledForMs = now() - stalledSince
    if (!reported && stalledForMs >= stallMs) {
      reported = true
      onStall({ pendingCount: status.pendingCount, upstreamHead, localHead: String(status.localHead), stalledForMs })
    }
  }

  const timer = setInterval(check, checkEveryMs)
  return () => clearInterval(timer)
}
