import { useEffect, useState } from "react"
import { peekOutboxBatch, subscribeToOutbox, type OutboxRecord } from "@/lib/sync/outbox"

/**
 * AQU-633: reactive view of outbox records the server refused with a 403 and
 * that were quarantined (`status: "failed"` + a 403 `lastError`). These are the
 * permission refusals — scope, self-validation, role floor, allowlist — that
 * would otherwise flip-then-revert behind a bare "N failed" pill.
 *
 * Reads straight from the outbox (all statuses, via peekOutboxBatch) rather than
 * a flush callback, so it captures a refusal regardless of WHICH flush path
 * quarantined it (the background drain, or any of ProjectWorkspace's immediate
 * flushOutboxBatch calls). `usePendingOutboxRecords` deliberately excludes
 * `failed` records, so it can't be reused here.
 */
export function useForbiddenOutboxRecords(enabled: boolean): OutboxRecord[] {
  const [records, setRecords] = useState<OutboxRecord[]>([])

  useEffect(() => {
    if (!enabled) {
      setRecords([])
      return
    }
    let cancelled = false

    async function refresh() {
      const all = await peekOutboxBatch(1000)
      if (cancelled) return
      const forbidden = all.filter(
        (r) => r.status === "failed" && r.lastError?.status === 403 && !!r.lastError.reason,
      )
      setRecords((prev) => (sameIds(prev, forbidden) ? prev : forbidden))
    }

    void refresh()
    const unsub = subscribeToOutbox(refresh)
    return () => {
      cancelled = true
      unsub()
    }
  }, [enabled])

  return records
}

/** Cheap identity: same record ids + reasons in the same order → no re-render. */
function sameIds(a: readonly OutboxRecord[], b: readonly OutboxRecord[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].lastError?.reason !== b[i].lastError?.reason) return false
  }
  return true
}
