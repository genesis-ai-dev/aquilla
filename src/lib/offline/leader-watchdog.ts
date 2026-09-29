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
import type { Store } from "@livestore/livestore"
import type { schema } from "./schema"

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
