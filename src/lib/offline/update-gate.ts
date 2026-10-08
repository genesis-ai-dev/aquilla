// Decides when a downloaded desktop update may be installed
// (src/components/DesktopUpdatePrompt.tsx, src-tauri/src/app_update.rs).
//
// A user who edited offline only gets an update once they're back online, and
// installing relaunches straight into the new build. Waiting for the queue to
// reach the server first means an upgrade can only cost re-downloadable cache,
// never unsent edits — even if the new build's offline schema couldn't read
// them.
import type { Store } from "@livestore/livestore"
import { outboxFailedCount, outboxPendingCount } from "@/lib/sync/outbox"
import { tables, type schema } from "./schema"

/**
 * How long a non-empty queue gets to send before the prompt offers "Update
 * anyway". Online, a healthy queue drains in seconds; one still there after
 * this is held up by something an update won't make worse (failed rows, a
 * project the server now refuses), and holding the update forever would also
 * block the fix.
 */
export const UPDATE_DRAIN_GRACE_MS = 2 * 60_000

export interface OfflineQueueSnapshot {
  /** Rows in any status — pending, flushing or failed. */
  count: number
  failed: number
}

export const EMPTY_QUEUE: OfflineQueueSnapshot = { count: 0, failed: 0 }

export type UpdateGate =
  | { kind: "clear" }
  /** Still sending — say nothing yet, the flusher is on it. */
  | { kind: "sending"; count: number }
  /** Not draining — offer to update anyway; the rows stay queued on this device. */
  | { kind: "stuck"; count: number }
  /**
   * The offline store failed to open, so its queue can't be read. Warn and
   * offer to update anyway rather than claim everything has sent.
   */
  | { kind: "unknown" }

export function readOfflineQueue(store: Store<typeof schema>): OfflineQueueSnapshot {
  const rows = store.query(tables.eventQueue.select("status"))
  return { count: rows.length, failed: rows.filter((status) => status === "failed").length }
}

/**
 * The IndexedDB outbox (src/lib/sync/outbox.ts). In the desktop app it still
 * carries every write the offline store doesn't take — comments, cell
 * create/delete/reorder, and any edit to a project that isn't downloaded.
 */
export async function readOutboxQueue(): Promise<OfflineQueueSnapshot> {
  const [count, failed] = await Promise.all([outboxPendingCount(), outboxFailedCount()])
  return { count, failed }
}

export function addQueues(a: OfflineQueueSnapshot, b: OfflineQueueSnapshot): OfflineQueueSnapshot {
  return { count: a.count + b.count, failed: a.failed + b.failed }
}

/** `queue` is null when the offline store failed to open and can't be read. */
export function evaluateUpdateGate(queue: OfflineQueueSnapshot | null, graceOver: boolean): UpdateGate {
  if (!queue) return { kind: "unknown" }
  if (queue.count === 0) return { kind: "clear" }
  // A failed row won't be retried on its own, so there's nothing to wait for.
  if (queue.failed > 0 || graceOver) return { kind: "stuck", count: queue.count }
  return { kind: "sending", count: queue.count }
}
