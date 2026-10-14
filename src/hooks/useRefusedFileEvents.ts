import { useEffect, useState } from "react"
import { peekOutboxBatch, subscribeToOutbox, type OutboxRecord } from "@/lib/sync/outbox"

/** A file-scoped outbox event the server will never accept. */
export interface RefusedFileEvent {
  /** Outbox record id — stable, so a caller can notify about it exactly once. */
  id: string
  fileId: string
  /** The server's refusal reason, when it gave one. */
  reason: string | null
  status: number
}

/**
 * AQU-797: reactive view of file-scoped events the outbox has given up on —
 * quarantined on a 403 (role floor, file out of scope, membership revoked) or
 * retry-exhausted on a deterministic 4xx.
 *
 * Optimistic overlays for file-shaped writes cannot be corrected by a refetch:
 * the overlay exists precisely BECAUSE the server read still carries the old
 * truth, so "the server still returns the file" reads identically to "the
 * delete hasn't flushed yet". Only the event's own death tells the two apart,
 * and the caller has to roll its overlay back on that signal.
 *
 * Read from the outbox (like `useForbiddenOutboxRecords`) rather than from a
 * flush callback, so a refusal is caught whichever path burned the record —
 * the background drain in `useOutboxFlusher` or a foreground
 * `flushOutboxBatch`.
 */
export function useRefusedFileEvents(
  projectId: string | null,
  kind: string,
): RefusedFileEvent[] {
  const [refused, setRefused] = useState<RefusedFileEvent[]>([])

  useEffect(() => {
    if (!projectId) {
      setRefused([])
      return
    }
    let cancelled = false

    async function refresh() {
      const all = await peekOutboxBatch(1000)
      if (cancelled) return
      const next = all
        .filter(
          (r) =>
            isPermanentlyRefused(r) &&
            r.event.kind === kind &&
            r.event.projectId === projectId &&
            !!r.event.fileId,
        )
        .map((r) => ({
          id: r.id,
          fileId: r.event.fileId as string,
          reason: r.lastError?.reason ?? null,
          status: r.lastError?.status ?? 0,
        }))
      setRefused((prev) => (sameRefusals(prev, next) ? prev : next))
    }

    void refresh()
    const unsub = subscribeToOutbox(refresh)
    return () => {
      cancelled = true
      unsub()
    }
  }, [projectId, kind])

  return refused
}

/**
 * `failed` alone is not enough: `requeueTransientlyFailedOutboxEvents` revives
 * records whose last error was a network drop (status 0) or a 5xx on the next
 * reconnect, so those are still going to be sent and their overlay must stand.
 * A 4xx is deterministic — the same event fails the same way forever.
 */
function isPermanentlyRefused(record: OutboxRecord): boolean {
  if (record.status !== "failed") return false
  const status = record.lastError?.status
  return status !== undefined && status >= 400 && status < 500
}

function sameRefusals(a: readonly RefusedFileEvent[], b: readonly RefusedFileEvent[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].fileId !== b[i].fileId || a[i].reason !== b[i].reason) return false
  }
  return true
}
