import { useEffect, useState, useRef, useCallback } from "react"
import { flushOutboxBatch } from "@/lib/sync/outbox-flush"
import { outboxPendingCount, subscribeToOutbox } from "@/lib/sync/outbox"

const BASE_INTERVAL_MS = 5000
const MAX_BACKOFF_MS = 60_000

export interface UseOutboxFlusherOptions {
  enabled: boolean
  projectId?: string
  getTokenForFile: (fileId: string) => Promise<string | null>
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
} {
  const [pending, setPending] = useState(0)
  const [failureStreak, setFailureStreak] = useState(0)
  const backoffExp = useRef(0)
  const tokenRef = useRef(options.getTokenForFile)
  tokenRef.current = options.getTokenForFile
  const projectIdRef = useRef(options.projectId)
  projectIdRef.current = options.projectId

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
        projectId: projectIdRef.current,
        getTokenForFile: (fid) => tokenRef.current(fid),
      })
      await refreshPending()
      const failedHard = result.posted > 0 && result.accepted === 0
      if (failedHard) {
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

  return { pendingCount: pending, failureStreak, refreshPending }
}
