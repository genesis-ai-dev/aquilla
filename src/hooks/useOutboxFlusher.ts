import { useEffect, useState, useRef, useCallback } from "react"
import { flushOutboxBatch, type StaleSiblingEntry } from "@/lib/sync/outbox-flush"
import { outboxPendingCount, subscribeToOutbox } from "@/lib/sync/outbox"

const BASE_INTERVAL_MS = 5000
const MAX_BACKOFF_MS = 60_000

export interface UseOutboxFlusherOptions {
  enabled: boolean
  /** Project-scoped token mint: takes the EVENT's projectId (not the active
   *  workspace's) so events queued in any project drain regardless of which
   *  project is currently open. See buildProjectAwareTokenFetcher. */
  getTokenForFile: (projectId: string, fileId: string) => Promise<string | null>
}

/**
 * Drains the CQRS IndexedDB outbox to POST /events. Uses Web Locks so only
 * one tab per origin runs the loop; falls back to a simple interval when
 * locks are unavailable (e.g. some test environments).
 */
export function useOutboxFlusher(options: UseOutboxFlusherOptions): {
  pendingCount: number
  failureStreak: number
  refreshPending: () => Promise<void>
  /** F6: increments whenever a flush returns stale-sibling dead-letters.
   *  Caller should surface "Some changes were rejected — newer edits won." */
  staleSiblingCount: number
  /** F6: the entries returned by the most recent flush that produced stale
   *  siblings. Carries `cellId`/`fileId` so the banner can deep-link the user
   *  to the affected cell's history drawer. Only the latest batch is kept —
   *  notifications-track persistence is intentionally out of scope. Cleared
   *  by `clearStaleSiblings()` when the user dismisses the banner. */
  staleSiblingEntries: StaleSiblingEntry[]
  /** Wipes `staleSiblingEntries` and resets `staleSiblingCount` to zero.
   *  Used by the banner's dismiss / "after-navigate" hooks so the surface
   *  doesn't keep re-firing for the same batch. */
  clearStaleSiblings: () => void
  /** F5: increments whenever a flush returns stale-source pins.
   *  Caller should surface "Source changed — please re-confirm." */
  staleSourceCount: number
} {
  const [pending, setPending] = useState(0)
  const [failureStreak, setFailureStreak] = useState(0)
  const [staleSiblingCount, setStaleSiblingCount] = useState(0)
  const [staleSiblingEntries, setStaleSiblingEntries] = useState<StaleSiblingEntry[]>([])
  const [staleSourceCount, setStaleSourceCount] = useState(0)
  const clearStaleSiblings = useCallback(() => {
    setStaleSiblingCount(0)
    setStaleSiblingEntries([])
  }, [])
  const backoffExp = useRef(0)
  const tokenRef = useRef(options.getTokenForFile)
  tokenRef.current = options.getTokenForFile

  const refreshPending = useCallback(async () => {
    setPending(await outboxPendingCount())
  }, [])

  useEffect(() => {
    void refreshPending()
    if (!options.enabled) return
    // Without this, the count only updates inside the flush cycle — and the
    // flush cycle short-circuits while offline, so a backlog of edits would
    // pile up in IDB invisibly.
    const unsub = subscribeToOutbox(() => void refreshPending())
    return unsub
  }, [refreshPending, options.enabled])

  useEffect(() => {
    if (!options.enabled) {
      setFailureStreak(0)
      backoffExp.current = 0
      return
    }

    let cancelled = false

    const runFlushCycle = async () => {
      const result = await flushOutboxBatch({
        getTokenForFile: (pid, fid) => tokenRef.current(pid, fid),
        onStaleSiblings: (entries) => {
          if (entries.length === 0) return
          setStaleSiblingCount((n) => n + entries.length)
          // Latest-batch wins. We deliberately don't merge with prior entries:
          // the banner shows one click-through target at a time, and stacking
          // ancient stale entries on top of fresh ones makes the action
          // ambiguous. The user dismisses (or clicks through) to clear.
          setStaleSiblingEntries(entries)
        },
        onStaleSource: (entries) => {
          setStaleSourceCount((n) => n + entries.length)
        },
      })
      await refreshPending()
      const failedHard = result.posted > 0 && result.accepted === 0
      // `authError` fires when there are queued rows but the token mint
      // failed. Without backoff this loop would re-mint every BASE_INTERVAL_MS
      // and hammer the auth-worker — visible to the user as constant token
      // requests / a "refreshing" feel even though nothing is succeeding.
      if (failedHard || result.authError) {
        setFailureStreak((s) => s + 1)
        backoffExp.current = Math.min(8, backoffExp.current + 1)
      } else {
        setFailureStreak(0)
        backoffExp.current = 0
      }
    }

    const tick = async () => {
      if (cancelled) return
      if (typeof navigator !== "undefined" && !navigator.onLine) return
      await runFlushCycle()
    }

    if (typeof navigator === "undefined" || !navigator.locks) {
      const iv = setInterval(() => void tick(), BASE_INTERVAL_MS)
      void tick()
      return () => {
        cancelled = true
        clearInterval(iv)
      }
    }

    const ac = new AbortController()

    void navigator.locks
      .request(
        "aquilla-cqrs-outbox-flush",
        { signal: ac.signal },
        async () => {
          while (!ac.signal.aborted) {
            const mult = Math.min(MAX_BACKOFF_MS / BASE_INTERVAL_MS, 2 ** backoffExp.current)
            const delay = Math.min(MAX_BACKOFF_MS, BASE_INTERVAL_MS * Math.max(1, mult))
            await new Promise((r) => setTimeout(r, delay))
            if (ac.signal.aborted) break
            if (typeof navigator !== "undefined" && !navigator.onLine) continue
            await runFlushCycle()
          }
        },
      )
      .catch(() => {})

    return () => {
      cancelled = true
      ac.abort()
    }
  }, [options.enabled, refreshPending])

  return {
    pendingCount: pending,
    failureStreak,
    refreshPending,
    staleSiblingCount,
    staleSiblingEntries,
    clearStaleSiblings,
    staleSourceCount,
  }
}
