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
import type { Store } from "@livestore/livestore"
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

// LiveStore's sequence number strings: e{global}[.{client}][r{rebaseGeneration}].
const SEQ_NUM = /^e(\d+)(?:\.(\d+))?(?:r\d+)?$/

/**
 * True once `upstreamHead` (what the leader has confirmed) has reached `head`
 * (a session's `localHead` right after a commit), i.e. the leader has written
 * that commit to its eventlog. Every offline event is client-only, so the
 * rebase generation never moves and is ignored. An unreadable head counts as
 * not persisted: the caller keeps its backup.
 */
export function leaderHasPersisted(upstreamHead: string, head: string): boolean {
  const upstream = SEQ_NUM.exec(upstreamHead)
  const target = SEQ_NUM.exec(head)
  if (!upstream || !target) return false
  const [upGlobal, upClient] = [Number(upstream[1]), Number(upstream[2] ?? 0)]
  const [global, client] = [Number(target[1]), Number(target[2] ?? 0)]
  return upGlobal > global || (upGlobal === global && upClient >= client)
}

type SyncStatusFeed = Pick<Store<typeof schema>, "syncStatus" | "subscribeSyncStatus">

/**
 * Calls `onPersisted` once the leader has persisted everything up to `head`
 * (see `leaderHasPersisted`); returns a function that stops waiting. A dead
 * leader never calls back — the stall watchdog covers that.
 */
export function watchLeaderPersisted(store: SyncStatusFeed, head: string, onPersisted: () => void): () => void {
  let done = false
  let unsubscribe: (() => void) | undefined
  const check = (upstreamHead: string) => {
    if (done || !leaderHasPersisted(upstreamHead, head)) return
    done = true
    unsubscribe?.()
    onPersisted()
  }
  try {
    check(store.syncStatus().upstreamHead)
    if (done) return () => {}
    unsubscribe = store.subscribeSyncStatus((status) => check(status.upstreamHead))
    if (done) unsubscribe()
  } catch (error) {
    // A store that shut down can't confirm anything; the caller's backup stays.
    console.warn("[offline] Couldn't watch the leader persist a commit", error)
  }
  return () => {
    done = true
    unsubscribe?.()
  }
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
