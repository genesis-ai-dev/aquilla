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
import { useOutboxFlusher } from "./useOutboxFlusher"

// ---------------------------------------------------------------------------
// Mock flushOutboxBatch and outboxPendingCount
// ---------------------------------------------------------------------------
vi.mock("@/lib/sync/outbox-flush", () => ({
  flushOutboxBatch: vi.fn(),
}))

vi.mock("@/lib/sync/outbox", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/sync/outbox")>()
  return {
    ...orig,
    outboxPendingCount: vi.fn().mockResolvedValue(0),
    outboxFailedCount: vi.fn().mockResolvedValue(0),
  }
})

import { flushOutboxBatch } from "@/lib/sync/outbox-flush"
import { outboxPendingCount } from "@/lib/sync/outbox"
const mockFlush = flushOutboxBatch as ReturnType<typeof vi.fn>
const mockPendingCount = outboxPendingCount as ReturnType<typeof vi.fn>

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
  mockFlush.mockReset()
  mockFlush.mockResolvedValue(NOTHING)
  mockPendingCount.mockReset()
  mockPendingCount.mockResolvedValue(0)

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
    mockFlush.mockResolvedValue(SUCCESS)

    renderHook(() =>
      useOutboxFlusher({ enabled: true, getTokenForFile: TOKEN_FN }),
    )

    // The hook calls tick() immediately on mount — advance 0ms to flush pending timers
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(mockFlush).toHaveBeenCalledTimes(1)

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
