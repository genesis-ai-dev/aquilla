/**
 * A batch confirm reads signatures and text. An edit still sitting in the
 * outbox is not in that read yet — an unvalidate, for example, still looks
 * like this person's signature, so the run skips the cell. Wait until those
 * records have landed, then read.
 *
 * A failed record is not syncing. Waiting on it would never finish, and the
 * run must not pretend a quarantined edit has been saved.
 */
import { readOutboxCounts, subscribeToOutbox } from "@/lib/sync/outbox"

export type OutboxSyncHold = "idle" | "synced" | "timeout"

const DEFAULT_TIMEOUT_MS = 60_000

function stillSyncing(counts: { count: number; failed: number }): boolean {
  return counts.count - counts.failed > 0
}

export async function holdBatchForSync(opts: {
  flushNow: () => void
  /** Called once, only when something is still syncing. */
  onWaiting: () => void
  timeoutMs?: number
  readCounts?: () => Promise<{ count: number; failed: number }>
  subscribe?: (cb: () => void) => () => void
}): Promise<OutboxSyncHold> {
  const readCounts = opts.readCounts ?? (() => readOutboxCounts())
  const subscribe = opts.subscribe ?? subscribeToOutbox
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!stillSyncing(await readCounts())) return "idle"

  opts.onWaiting()
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: OutboxSyncHold) => {
      if (settled) return
      settled = true
      unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
      resolve(result)
    }
    const check = () => {
      void readCounts().then((counts) => {
        if (!stillSyncing(counts)) finish("synced")
      }).catch(() => {
        // An unreadable outbox is not an empty one. Keep waiting.
      })
    }
    unsubscribe = subscribe(check)
    opts.flushNow()
    timer = setTimeout(() => finish("timeout"), timeoutMs)
    check()
  })
}
