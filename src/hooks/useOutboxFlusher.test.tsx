/**
 * Unit tests for useOutboxFlusher.ts
 *
 * Uses vi.useFakeTimers() for deterministic time control and vi.mock() to
 * intercept flushOutboxBatch. Tests cover:
 *   - enabled:false path (no flush, no timer)
 *   - Interval fallback when navigator.locks is unavailable
 *   - Backoff progression on consecutive failures
 *   - Backoff reset on success
 *   - navigator.onLine=false skips tick
 *   - navigator.locks path: lock acquired, loop ticks, abort on unmount
 *   - refreshPending() updates state
 *   - Dead exponent cap (QA finding F): effective ceiling documented
 *
 * NOTE: fake-indexeddb uses setImmediate/setTimeout internally, so we also
 * mock outboxPendingCount to avoid IDB operations while fake timers are active.
 *
 * navigator.locks is mocked via Object.defineProperty per beforeEach/afterEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useOutboxFlusher, drainCycle } from "./useOutboxFlusher"

// ---------------------------------------------------------------------------
// Mock flushOutboxBatch and outboxPendingCount
// ---------------------------------------------------------------------------
vi.mock("@/lib/sync/outbox-flush", () => ({
  flushOutboxBatch: vi.fn(),
}))

// SUB-48: the wake-on-enqueue path is driven through the outbox subscription,
// so the harness captures subscribers instead of touching fake IDB.
const outboxHarness = vi.hoisted(() => ({ subscribers: new Set<() => void>() }))

vi.mock("@/lib/sync/outbox", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/sync/outbox")>()
  return {
    ...orig,
    outboxPendingCount: vi.fn().mockResolvedValue(0),
    outboxFailedCount: vi.fn().mockResolvedValue(0),
    requeueTransientlyFailedOutboxEvents: vi.fn().mockResolvedValue(undefined),
    subscribeToOutbox: (cb: () => void) => {
      outboxHarness.subscribers.add(cb)
      return () => outboxHarness.subscribers.delete(cb)
    },
  }
})

import { flushOutboxBatch } from "@/lib/sync/outbox-flush"
import { outboxPendingCount, requeueTransientlyFailedOutboxEvents } from "@/lib/sync/outbox"
const mockFlush = flushOutboxBatch as ReturnType<typeof vi.fn>
const mockPendingCount = outboxPendingCount as ReturnType<typeof vi.fn>
const mockRequeue = requeueTransientlyFailedOutboxEvents as ReturnType<typeof vi.fn>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUCCESS = { posted: 1, accepted: 1, networkError: false }
const FAIL = { posted: 1, accepted: 0, networkError: true }
const NOTHING = { posted: 0, accepted: 0, networkError: false }

const TOKEN_FN = async (): Promise<import("@/lib/sync/outbox-flush").TokenMintResult> => ({ token: "tok", status: 200 })

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalOnLine: PropertyDescriptor | undefined
let originalLocks: PropertyDescriptor | undefined

beforeEach(() => {
  vi.useFakeTimers()
  outboxHarness.subscribers.clear()
  mockFlush.mockReset()
  mockFlush.mockResolvedValue(NOTHING)
  mockPendingCount.mockReset()
  mockPendingCount.mockResolvedValue(0)
  mockRequeue.mockReset()
  mockRequeue.mockResolvedValue(undefined)

  // Snapshot the original descriptors so we can restore them
  originalOnLine =
    Object.getOwnPropertyDescriptor(navigator, "onLine") ??
    Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine")
  originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks")
})

afterEach(() => {
  vi.useRealTimers()
  // Restore navigator.onLine
  if (originalOnLine) {
    Object.defineProperty(navigator, "onLine", {
      ...originalOnLine,
      configurable: true,
    })
  }
  // Restore navigator.locks
  if (originalLocks) {
    Object.defineProperty(navigator, "locks", {
      ...originalLocks,
      configurable: true,
    })
  } else {
    try {
      Object.defineProperty(navigator, "locks", {
        value: undefined,
        configurable: true,
      })
    } catch {
      /* ignore */
    }
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useOutboxFlusher", () => {
  // -- enabled: false --------------------------------------------------------

  it("does not call flushOutboxBatch and pendingCount is 0 when enabled is false", async () => {
    // Remove locks so we go through the setInterval path
    Object.defineProperty(navigator, "locks", {
      value: undefined,
      configurable: true,
    })

    const { result } = renderHook(() =>
      useOutboxFlusher({ enabled: false, getTokenForFile: TOKEN_FN }),
    )

    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })

    expect(mockFlush).not.toHaveBeenCalled()
    expect(result.current.pendingCount).toBe(0)
  })

  // -- Interval fallback (no locks) ------------------------------------------

  it("falls back to setInterval and calls flushOutboxBatch after 5s when navigator.locks is undefined", async () => {
    Object.defineProperty(navigator, "locks", {
      value: undefined,
      configurable: true,
    })
    // Use NOTHING so drainCycle terminates in 1 call per cycle (posted:0 → break).
    // This tests that the interval path calls flush — not how many times per cycle.
    mockFlush.mockResolvedValue(NOTHING)

    renderHook(() =>
      useOutboxFlusher({ enabled: true, getTokenForFile: TOKEN_FN }),
    )

    // The hook calls tick() immediately on mount — advance 0ms to flush pending timers
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // At least one call from the initial tick
    expect(mockFlush.mock.calls.length).toBeGreaterThanOrEqual(1)

    // Advance one more interval
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })

    expect(mockFlush.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  // -- Backoff progression ---------------------------------------------------
  //
  // The backoff (exponential delay) only exists in the navigator.locks path.
  // The setInterval fallback path always fires at BASE_INTERVAL_MS (5s) regardless
  // of failures. Tests that verify backoff MUST use the locks path.

  it("failureStreak increments on each failed flush and delay grows after consecutive failures (locks path)", async () => {
    mockFlush.mockResolvedValue(FAIL)

    // Set up locks mock that actually invokes the callback (so the while loop runs)
    let callbackStarted = false
    const locksMock = {
      request: async (
        _name: string,
        _opts: { signal: AbortSignal },
        cb: () => Promise<void>,
      ): Promise<void> => {
        callbackStarted = true
        await cb()
      },
    }
    Object.defineProperty(navigator, "locks", {
      value: locksMock,
      configurable: true,
    })

    const { result } = renderHook(() =>
      useOutboxFlusher({ enabled: true, getTokenForFile: TOKEN_FN }),
    )

    // Wait for the lock callback to start (the while loop begins with a delay,
    // but the first delay uses backoffExp=0 → mult=max(1, 2^0)=1 → 5s)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(callbackStarted).toBe(true)

    // Tick 1: advance past first delay (5s at exp=0), flush FAIL → exp→1
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(result.current.failureStreak).toBe(1)

    // Tick 2: next delay is 5s * 2^1 = 10s. Advance 10s → flush FAIL → exp→2
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(result.current.failureStreak).toBe(2)

    // Tick 3: next delay is 5s * 2^2 = 20s. Advance 20s → flush FAIL → exp→3
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(result.current.failureStreak).toBe(3)

    // After 3 failures backoffExp=3, next delay = 5s * 2^3 = 40s.
    // Verify the hook does NOT flush after only 5s
    const callsBefore = mockFlush.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(mockFlush.mock.calls.length).toBe(callsBefore)
  })

  // -- RACE-4/M1-5: reentrancy guard (interval fallback) ─────────────────────

  it("RACE-4: does not overlap flush ticks when a flush takes longer than the interval (interval fallback)", async () => {
    Object.defineProperty(navigator, "locks", {
      value: undefined,
      configurable: true,
    })

    // Make the flush take longer than the interval (7s when interval is 5s).
    let resolveSlow: (() => void) | null = null
    mockFlush.mockImplementation(
      () =>
        new Promise<typeof NOTHING>((resolve) => {
          resolveSlow = () => resolve(NOTHING)
        }),
    )

    renderHook(() =>
      useOutboxFlusher({ enabled: true, getTokenForFile: TOKEN_FN }),
    )

    // Initial tick fires immediately — flush is in flight (slow)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(mockFlush).toHaveBeenCalledTimes(1)

    // Advance past the interval (5s) — the reentrancy guard must block a second tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    // Only 1 call — the in-flight guard must have blocked the second interval tick.
    expect(mockFlush).toHaveBeenCalledTimes(1)

    // Resolve the slow flush — the guard clears.
    await act(async () => {
      resolveSlow?.()
    })

    // Next interval tick can now proceed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(mockFlush).toHaveBeenCalledTimes(2)
  })

  // -- RES-2: auto-requeue on online event ───────────────────────────────────

  it("RES-2: calls requeueTransientlyFailedOutboxEvents when the online event fires", async () => {
    Object.defineProperty(navigator, "locks", {
      value: undefined,
      configurable: true,
    })
    Object.defineProperty(navigator, "onLine", {
      value: true,
      configurable: true,
      writable: true,
    })
    mockFlush.mockResolvedValue(SUCCESS)

    renderHook(() =>
      useOutboxFlusher({ enabled: true, getTokenForFile: TOKEN_FN }),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    const callsBefore = mockRequeue.mock.calls.length

    // Fire the online event.
    await act(async () => {
      window.dispatchEvent(new Event("online"))
      await vi.advanceTimersByTimeAsync(0)
    })

    // requeueTransientlyFailedOutboxEvents must have been called.
    expect(mockRequeue.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  // -- Backoff reset on success ----------------------------------------------

  it("failureStreak resets to 0 after a successful flush following a failure (locks path)", async () => {
    mockFlush.mockResolvedValueOnce(FAIL).mockResolvedValue(SUCCESS)

    const locksMock = {
      request: async (
        _name: string,
        _opts: { signal: AbortSignal },
        cb: () => Promise<void>,
      ): Promise<void> => {
        await cb()
      },
    }
    Object.defineProperty(navigator, "locks", {
      value: locksMock,
      configurable: true,
    })

    const { result } = renderHook(() =>
      useOutboxFlusher({ enabled: true, getTokenForFile: TOKEN_FN }),
    )

    // Tick 1: first delay 5s (exp=0 → mult=1 → 5s) → FAIL → failureStreak=1, backoffExp=1, next delay=10s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(result.current.failureStreak).toBe(1)

    // Tick 2: advance past the 10s backoff → SUCCESS → failureStreak resets to 0
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    // advanceTimersByTimeAsync runs the timer AND flushes the resulting microtasks,
    // so the state update from SUCCESS should be synchronously committed after act()
    expect(result.current.failureStreak).toBe(0)
  })

  // -- navigator.onLine = false ----------------------------------------------

  it("skips the flush tick when navigator.onLine is false", async () => {
    Object.defineProperty(navigator, "locks", {
      value: undefined,
      configurable: true,
    })
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
      writable: true,
    })
    mockFlush.mockResolvedValue(SUCCESS)

    renderHook(() =>
      useOutboxFlusher({ enabled: true, getTokenForFile: TOKEN_FN }),
    )

    // Initial tick is skipped because onLine=false
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })

    expect(mockFlush).not.toHaveBeenCalled()

    // Bring back online
    Object.defineProperty(navigator, "onLine", {
      value: true,
      configurable: true,
      writable: true,
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })

    expect(mockFlush).toHaveBeenCalled()
  })

  // -- navigator.locks path --------------------------------------------------

  it("runs flush loop via navigator.locks when available; abort signal fires on unmount", async () => {
    mockFlush.mockResolvedValue(SUCCESS)

    // Provide a minimal navigator.locks mock that captures the abort signal
    let capturedAbort: AbortSignal | null = null

    const locksMock = {
      request: (
        _name: string,
        opts: { signal: AbortSignal },
        _cb: () => Promise<void>,
      ): Promise<void> => {
        capturedAbort = opts.signal
        // Don't invoke the callback — we just want to verify the signal plumbing
        return new Promise(() => {}) // never resolves (simulates lock held)
      },
    }

    Object.defineProperty(navigator, "locks", {
      value: locksMock,
      configurable: true,
    })

    const { unmount } = renderHook(() =>
      useOutboxFlusher({ enabled: true, getTokenForFile: TOKEN_FN }),
    )

    // Give the hook time to register the lock request
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(capturedAbort).not.toBeNull()
    expect(capturedAbort!.aborted).toBe(false)

    // Unmount should abort the signal via AbortController
    unmount()
    expect(capturedAbort!.aborted).toBe(true)
  })

  // -- refreshPending --------------------------------------------------------

  it("refreshPending updates pendingCount from the outbox", async () => {
    Object.defineProperty(navigator, "locks", {
      value: undefined,
      configurable: true,
    })
    // Mock outboxPendingCount to return 3
    mockPendingCount.mockResolvedValue(3)

    const { result } = renderHook(() =>
      useOutboxFlusher({ enabled: false, getTokenForFile: TOKEN_FN }),
    )

    await act(async () => {
      await result.current.refreshPending()
    })

    expect(result.current.pendingCount).toBe(3)
  })

  it("clears a provisional stale-source warning after authoritative reconciliation", async () => {
    Object.defineProperty(navigator, "locks", {
      value: undefined,
      configurable: true,
    })
    let emitted = false
    mockFlush.mockImplementation(async (deps) => {
      if (!emitted) {
        emitted = true
        deps.onStaleSource?.([{ id: "target-1", currentSourceEventId: "source-2" }])
      }
      return NOTHING
    })

    const { result } = renderHook(() =>
      useOutboxFlusher({ enabled: true, getTokenForFile: TOKEN_FN }),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.staleSourceCount).toBe(1)

    act(() => result.current.clearStaleSource())
    expect(result.current.staleSourceCount).toBe(0)
  })

  // -- drainCycle: loop-until-drained pure helper ----------------------------

  describe("drainCycle (bounded drain loop)", () => {
    it("loops until posted===0: stub returning 100 accepted twice then 50 then 0 → madeProgress=true, 3 productive iterations", async () => {
      // Simulates 250-record drain: first call posts 100 & accepts 100,
      // second posts 100 & accepts 100, third posts 50 & accepts 50,
      // fourth returns posted:0 → loop exits. Total productive: 3 iterations.
      const flush = vi
        .fn()
        .mockResolvedValueOnce({ posted: 100, accepted: 100, networkError: false, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 })
        .mockResolvedValueOnce({ posted: 100, accepted: 100, networkError: false, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 })
        .mockResolvedValueOnce({ posted: 50, accepted: 50, networkError: false, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 })
        .mockResolvedValueOnce({ posted: 0, accepted: 0, networkError: false, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0 })

      const result = await drainCycle(flush)

      expect(result.madeProgress).toBe(true)
      expect(result.sawAuthError).toBe(false)
      // 3 productive calls + 1 terminating call (posted:0)
      expect(flush).toHaveBeenCalledTimes(4)
      expect(result.iterations).toBe(4)
    })

    it("no-busy-spin: breaks after 1 iteration when accepted===0 (all rejected, no forward progress)", async () => {
      const flush = vi.fn().mockResolvedValue({
        posted: 10, accepted: 0, networkError: true, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0,
      })

      const result = await drainCycle(flush)

      // Must NOT keep calling flush in a busy loop — break immediately on no-progress
      expect(flush).toHaveBeenCalledTimes(1)
      expect(result.madeProgress).toBe(false)
      expect(result.iterations).toBe(1)
    })

    it("authError: breaks immediately and sets sawAuthError=true", async () => {
      const flush = vi.fn().mockResolvedValue({
        posted: 5, accepted: 0, networkError: false, authError: true, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0,
      })

      const result = await drainCycle(flush)

      expect(flush).toHaveBeenCalledTimes(1)
      expect(result.sawAuthError).toBe(true)
      expect(result.madeProgress).toBe(false)
    })

    it("empty queue (posted===0 on first call): 0 iterations, madeProgress=false", async () => {
      const flush = vi.fn().mockResolvedValue({
        posted: 0, accepted: 0, networkError: false, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0,
      })

      const result = await drainCycle(flush)

      // posted:0 on first call → loop breaks immediately (0 iterations means we broke at iter=0)
      expect(flush).toHaveBeenCalledTimes(1)
      expect(result.madeProgress).toBe(false)
      expect(result.sawAuthError).toBe(false)
    })

    it("MAX_DRAIN_ITERATIONS backstop: stops at 200 iterations even if flush always returns accepted>0", async () => {
      // Simulates a pathological case where records keep appearing — the backstop must prevent infinite loop
      const flush = vi.fn().mockResolvedValue({
        posted: 100, accepted: 100, networkError: false, authError: false, quarantined: 0, staleSiblingCount: 0, staleSourceCount: 0,
      })

      const result = await drainCycle(flush)

      // Should have been called exactly MAX_DRAIN_ITERATIONS (200) times and then stopped
      expect(flush).toHaveBeenCalledTimes(200)
      expect(result.iterations).toBe(200)
      expect(result.madeProgress).toBe(true)
    })
  })

  // -- Dead exponent cap (QA finding F) --------------------------------------

  it(
    "QA FINDING F — dead exponent cap: effective ceiling is at backoffExp=4 (2^4=16 > mult cap 12 → 60s); " +
      "the Math.min(8, ...) cap in the hook code is dead code — exponent never needs to exceed 4",
    async () => {
      // The hook has: backoffExp = Math.min(8, backoffExp + 1)
      // But the delay formula: mult = Math.min(12, 2^backoffExp), delay = 5000 * max(1, mult)
      // At backoffExp=4: 2^4=16, clamped to 12 → 5000*12 = 60000ms (MAX_BACKOFF_MS)
      // At backoffExp=5+: 2^5+=32+, still clamped to 12 → still 60000ms
      // Therefore Math.min(8, ...) is unreachable in practice — 4 is the effective cap.
      //
      // This test uses the navigator.locks path (backoff only exists there).

      mockFlush.mockResolvedValue(FAIL)

      const locksMock = {
        request: async (
          _name: string,
          _opts: { signal: AbortSignal },
          cb: () => Promise<void>,
        ): Promise<void> => {
          await cb()
        },
      }
      Object.defineProperty(navigator, "locks", {
        value: locksMock,
        configurable: true,
      })

      const { result } = renderHook(() =>
        useOutboxFlusher({ enabled: true, getTokenForFile: TOKEN_FN }),
      )

      // Drive backoffExp from 0→4 through 4 failures in the locks while-loop
      // Initial delay: 5s * max(1, 2^0=1) = 5s → flush → exp=1
      // Then: 5s * 2^1=10s → flush → exp=2
      // Then: 5s * 2^2=20s → flush → exp=3
      // Then: 5s * 2^3=40s → flush → exp=4
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) }) // tick 1, exp→1
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) }) // tick 2, exp→2
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000) }) // tick 3, exp→3
      await act(async () => { await vi.advanceTimersByTimeAsync(40_000) }) // tick 4, exp→4

      expect(result.current.failureStreak).toBe(4)

      // At exp=4, next delay = 5000 * min(12, 2^4=16) = 5000 * 12 = 60000ms (MAX_BACKOFF_MS)
      const callsBefore = mockFlush.mock.calls.length

      // Advance 59s — must NOT fire yet (ceiling is 60s)
      await act(async () => { await vi.advanceTimersByTimeAsync(59_000) })
      expect(mockFlush.mock.calls.length).toBe(callsBefore)

      // Advance final 1s → fires at 60s
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(mockFlush.mock.calls.length).toBe(callsBefore + 1)
    },
  )
})

// ---------------------------------------------------------------------------
// SUB-48 — wake on new work
//
// Enqueuing never used to wake the loop: an event saved just after a tick sat
// idle for a full interval, and up to the 60s backoff cap once failures had
// stretched it. That is how a just-recorded take stayed unsent for minutes.
// ---------------------------------------------------------------------------

describe("useOutboxFlusher — wake on enqueue (SUB-48)", () => {
  const fireOutboxNotification = async () => {
    await act(async () => {
      outboxHarness.subscribers.forEach((cb) => cb())
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  it("flushes promptly when the queue GROWS, without waiting out the interval", async () => {
    Object.defineProperty(navigator, "locks", { value: undefined, configurable: true })
    mockFlush.mockResolvedValue(NOTHING)

    renderHook(() => useOutboxFlusher({ enabled: true, getTokenForFile: TOKEN_FN }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) }) // mount tick
    mockFlush.mockClear()

    // A recording is saved one tick after the last cycle.
    mockPendingCount.mockResolvedValue(1)
    await fireOutboxNotification()

    // No timer advance beyond the microtask drain: the wake did it.
    expect(mockFlush).toHaveBeenCalled()
  })

  it("does NOT wake on acks, attempt stamps or quarantines (queue did not grow)", async () => {
    Object.defineProperty(navigator, "locks", { value: undefined, configurable: true })
    mockFlush.mockResolvedValue(NOTHING)

    // Start with work already queued so a later notification can leave the
    // count flat (stamp) or lower it (ack) without ever growing it.
    mockPendingCount.mockResolvedValue(2)
    renderHook(() => useOutboxFlusher({ enabled: true, getTokenForFile: TOKEN_FN }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    mockFlush.mockClear()

    mockPendingCount.mockResolvedValue(2) // attempt stamped — same size
    await fireOutboxNotification()
    expect(mockFlush).not.toHaveBeenCalled()

    mockPendingCount.mockResolvedValue(0) // batch acked — records removed
    await fireOutboxNotification()
    expect(mockFlush).not.toHaveBeenCalled()
  })

  it("the wake earns ONE attempt but does not reset backoff (locks path)", async () => {
    // Had the wake reset backoff, the queue would resume hammering a failing
    // server every 5s — the very thing the exponential delay exists to stop.
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true, writable: true })
    Object.defineProperty(navigator, "locks", {
      value: {
        request: async (_n: string, _o: { signal: AbortSignal }, cb: () => Promise<void>) => { await cb() },
      },
      configurable: true,
    })
    mockFlush.mockResolvedValue(FAIL)

    const { result } = renderHook(() =>
      useOutboxFlusher({ enabled: true, getTokenForFile: TOKEN_FN }),
    )
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })  // exp → 1
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) }) // exp → 2, next sleep 20s
    expect(result.current.failureStreak).toBe(2)

    // New work lands mid-backoff: exactly one prompt attempt.
    const before = mockFlush.mock.calls.length
    mockPendingCount.mockResolvedValue(1)
    await fireOutboxNotification()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(mockFlush.mock.calls.length).toBe(before + 1)
    expect(result.current.failureStreak).toBe(3) // never reset to 0 by the wake

    // …and the protection clock is still long (exp=3 → 40s), not back to 5s.
    const afterWake = mockFlush.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(39_000) })
    expect(mockFlush.mock.calls.length).toBe(afterWake)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(mockFlush.mock.calls.length).toBe(afterWake + 1)
  })
})
