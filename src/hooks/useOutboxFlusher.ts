import { useEffect, useState, useRef, useCallback } from "react"
import { flushOutboxBatch, type StaleSiblingEntry, type TokenMintResult } from "@/lib/sync/outbox-flush"
import { outboxPendingCount, outboxFailedCount, subscribeToOutbox, requeueTransientlyFailedOutboxEvents } from "@/lib/sync/outbox"

const BASE_INTERVAL_MS = 5000
const MAX_BACKOFF_MS = 60_000
const MAX_DRAIN_ITERATIONS = 200 // backstop: 200 × ≤100 = up to ~20k events/cycle

// ---------------------------------------------------------------------------
// drainCycle — pure bounded drain loop; exported for unit testing.
// Calls `flush` repeatedly until the queue stops making forward progress
// (posted===0 or accepted===0) or authError occurs, bounded by MAX_DRAIN_ITERATIONS.
// ---------------------------------------------------------------------------

export interface DrainCycleResult {
  iterations: number
  madeProgress: boolean
  /** True if at least one call returned posted > 0 (i.e. there was a queue
   *  to drain, even if ultimately nothing was accepted). Used to distinguish
   *  "empty queue" (no backoff needed) from "tried but all rejected" (backoff). */
  postedAny: boolean
  sawAuthError: boolean
}

type FlushResult = Awaited<ReturnType<typeof import("@/lib/sync/outbox-flush").flushOutboxBatch>>

export async function drainCycle(
  flush: () => Promise<FlushResult>,
): Promise<DrainCycleResult> {
  let madeProgress = false
  let postedAny = false
  let sawAuthError = false
  let calls = 0
  while (calls < MAX_DRAIN_ITERATIONS) {
    const result = await flush()
    calls++
    if (result.authError) {
      sawAuthError = true
      break
    }
    if (result.posted === 0) break          // nothing left to send
    postedAny = true
    if (result.accepted === 0) break         // batch made no forward progress
    madeProgress = true
  }
  return { iterations: calls, madeProgress, postedAny, sawAuthError }
}

export interface UseOutboxFlusherOptions {
  enabled: boolean
  /** Project-scoped token mint: takes the EVENT's projectId (not the active
   *  workspace's) so events queued in any project drain regardless of which
   *  project is currently open. Returns `{ token, status }` so a permanent
   *  mint-403 quarantines-and-advances instead of wedging. See
   *  buildProjectAwareMinter. */
  getTokenForFile: (projectId: string, fileId: string) => Promise<TokenMintResult>
  /** Opaque marker of the current auth identity (e.g. the active JWT). When it
   *  changes — i.e. the user signed in / re-authed / switched account — the
   *  flusher resets its backoff and forces an immediate flush so a recovered
   *  session drains the queue promptly instead of waiting out the backoff. */
  authEpoch?: string | number | null
}

/**
 * Drains the CQRS IndexedDB outbox to POST /events. Uses Web Locks so only
 * one tab per origin runs the loop; falls back to a simple interval when
 * locks are unavailable (e.g. some test environments).
 */
export function useOutboxFlusher(options: UseOutboxFlusherOptions): {
  pendingCount: number
  failureStreak: number
  /** Re-reads the queue sizes; resolves with the total (pending + failed). */
  refreshPending: () => Promise<number>
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
  /** Count of records that permanently failed / were quarantined (excluded from
   *  the auto-retry queue). Surfaced separately from `pendingCount` so the
   *  indicator can distinguish "still syncing" from "needs your attention". */
  failedCount: number
  /** Reset backoff and force an immediate flush. Wired to the inspector's
   *  "Retry now" button and to network-reconnect / re-auth. */
  flushNow: () => void
} {
  const [pending, setPending] = useState(0)
  const [failed, setFailed] = useState(0)
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
  // Resolver for the lock loop's current sleep, so flushNow() can cut a long
  // backoff short and run immediately. The interval-fallback path uses tickRef.
  const wakeRef = useRef<(() => void) | null>(null)
  const tickRef = useRef<(() => void) | null>(null)

  // Last observed queue size, so an outbox notification can tell "new work
  // arrived" (wake) from "a record was acked / stamped / quarantined" (don't).
  const lastTotalRef = useRef(0)

  const refreshPending = useCallback(async () => {
    const [total, failedN] = await Promise.all([outboxPendingCount(), outboxFailedCount()])
    setPending(total)
    setFailed(failedN)
    lastTotalRef.current = total
    return total
  }, [])

  const flushNow = useCallback(() => {
    backoffExp.current = 0
    setFailureStreak(0)
    // Wake an in-progress backoff sleep (locks path) or trigger a tick
    // (interval fallback). Whichever is active fires; the other is a no-op.
    wakeRef.current?.()
    tickRef.current?.()
  }, [])

  useEffect(() => {
    void refreshPending()
    if (!options.enabled) return
    // Without this, the count only updates inside the flush cycle — and the
    // flush cycle short-circuits while offline, so a backlog of edits would
    // pile up in IDB invisibly.
    const unsub = subscribeToOutbox(() => {
      const before = lastTotalRef.current
      void refreshPending().then((total) => {
        // SUB-48: new work must not wait out the current sleep. Enqueuing never
        // used to wake the loop, so an event saved just after a tick sat idle
        // for a full interval — and up to the 60s backoff cap once failures had
        // stretched it, which is how a just-recorded take could stay unsent for
        // minutes. Wake only when the queue GREW: acks, attempt stamps and
        // quarantines notify too, and waking on those would spin. Deliberately
        // does NOT reset backoff — new work earns one prompt attempt, not a
        // reset of the server-protection clock (that stays with flushNow()).
        if (total > before) {
          wakeRef.current?.()
          tickRef.current?.()
        }
      })
    })
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
      const { madeProgress, postedAny, sawAuthError } = await drainCycle(() =>
        flushOutboxBatch({
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
        }),
      )
      await refreshPending()
      // failedHard: we attempted to post something but accepted nothing.
      // An empty queue (postedAny=false) is NOT a failure — no backoff needed.
      const failedHard = postedAny && !madeProgress
      // `authError` fires when there are queued rows but the token mint
      // failed. Without backoff this loop would re-mint every BASE_INTERVAL_MS
      // and hammer the auth-worker — visible to the user as constant token
      // requests / a "refreshing" feel even though nothing is succeeding.
      if (failedHard || sawAuthError) {
        setFailureStreak((s) => s + 1)
        backoffExp.current = Math.min(8, backoffExp.current + 1)
      } else {
        setFailureStreak(0)
        backoffExp.current = 0
      }
    }

    // RACE-4: in-flight guard for the no-Web-Locks fallback. Prevents a slow
    // flush tick from overlapping the next interval tick and double-POSTing the
    // same events. The Web Locks path is already protected by the lock itself.
    let fallbackInFlight = false

    const tick = async () => {
      if (cancelled) return
      if (typeof navigator !== "undefined" && !navigator.onLine) return
      // Reentrancy guard: skip this tick if a prior flush is still running.
      if (fallbackInFlight) return
      fallbackInFlight = true
      try {
        await runFlushCycle()
      } finally {
        fallbackInFlight = false
      }
    }

    if (typeof navigator === "undefined" || !navigator.locks) {
      tickRef.current = () => void tick()
      const iv = setInterval(() => void tick(), BASE_INTERVAL_MS)
      void tick()
      return () => {
        cancelled = true
        tickRef.current = null
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
            // Interruptible sleep: flushNow() (Retry / reconnect / re-auth)
            // resolves this early so a recovered session doesn't wait out a
            // 60s backoff before draining.
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, delay)
              wakeRef.current = () => {
                clearTimeout(t)
                wakeRef.current = null
                resolve()
              }
            })
            wakeRef.current = null
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

  // Network reconnect → requeue transiently-failed records + drain immediately
  // rather than waiting out the backoff. RES-2: records that failed due to
  // status 0 / 5xx (no budget burn) get revived so they can retry now.
  useEffect(() => {
    if (!options.enabled) return
    if (typeof window === "undefined") return
    const onOnline = () => {
      void requeueTransientlyFailedOutboxEvents().then(() => flushNow())
    }
    window.addEventListener("online", onOnline)
    return () => window.removeEventListener("online", onOnline)
  }, [options.enabled, flushNow])

  // Auth identity changed (sign-in / re-auth / account switch) → a previously
  // un-mintable queue may now succeed; requeue transient failures, reset backoff
  // and flush now. Skip the initial mount (no prior epoch) so we don't double-flush.
  const prevEpoch = useRef<UseOutboxFlusherOptions["authEpoch"]>(options.authEpoch)
  useEffect(() => {
    if (!options.enabled) return
    if (prevEpoch.current !== options.authEpoch) {
      prevEpoch.current = options.authEpoch
      // RES-2: auth epoch change may fix token-mint failures that stamped status
      // on records without burning the budget. Revive them so they retry now.
      void requeueTransientlyFailedOutboxEvents().then(() => flushNow())
    }
  }, [options.enabled, options.authEpoch, flushNow])

  return {
    pendingCount: pending,
    failedCount: failed,
    failureStreak,
    refreshPending,
    flushNow,
    staleSiblingCount,
    staleSiblingEntries,
    clearStaleSiblings,
    staleSourceCount,
  }
}
