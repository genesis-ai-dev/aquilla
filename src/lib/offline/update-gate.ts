// Install only after the queues drain, so an update can never cost unsent edits.
import type { Store } from "@livestore/livestore"
import { readOutboxCounts } from "@/lib/sync/outbox"
import { tables, type schema } from "./schema"

/** A queue still non-empty after this is stuck; holding the update forever would block its fix too. */
export const UPDATE_DRAIN_GRACE_MS = 2 * 60_000

export interface OfflineQueueSnapshot {
  /** Rows in any status — pending, flushing or failed. */
  count: number
  failed: number
}

export const EMPTY_QUEUE: OfflineQueueSnapshot = { count: 0, failed: 0 }

export type UpdateGate =
  | { kind: "clear" }
  | { kind: "sending"; count: number }
  /** `failed` rows won't resend after the restart either. */
  | { kind: "stuck"; count: number; failed: number }
  /** A queue couldn't be read; don't claim everything sent. */
  | { kind: "unknown" }

export function readOfflineQueue(store: Store<typeof schema>): OfflineQueueSnapshot {
  const rows = store.query(tables.eventQueue.select("status"))
  return { count: rows.length, failed: rows.filter((status) => status === "failed").length }
}

/** Desktop still routes writes the offline store doesn't take here. Null = unreadable, not empty. */
export async function readOutboxQueue(): Promise<OfflineQueueSnapshot | null> {
  try {
    return await readOutboxCounts()
  } catch (error) {
    console.warn("[update] couldn't read the outbox", error)
    return null
  }
}

export function addQueues(a: OfflineQueueSnapshot, b: OfflineQueueSnapshot): OfflineQueueSnapshot {
  return { count: a.count + b.count, failed: a.failed + b.failed }
}

/** `queue` is null when either queue couldn't be read. */
export function evaluateUpdateGate(queue: OfflineQueueSnapshot | null, graceOver: boolean): UpdateGate {
  if (!queue) return { kind: "unknown" }
  if (queue.count === 0) return { kind: "clear" }
  // Failed rows never retry on their own; nothing to wait for.
  if (queue.failed > 0 || graceOver) return { kind: "stuck", count: queue.count, failed: queue.failed }
  return { kind: "sending", count: queue.count }
}
