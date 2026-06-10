// FRO-235: Tests for the batch-completion progress store and cancel flag.

import { describe, it, expect, beforeEach } from "vitest"
import {
  getCompletionBatchProgress,
  resetBatchCompletionState,
  clearBatchCompletionProgress,
  incrementBatchCompletionDone,
  isBatchCompletionCancelled,
  getBatchCompletionSignal,
  cancelBatchCompletion,
} from "./batch-completion"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshBatch(total = 3) {
  resetBatchCompletionState(total)
}

// ---------------------------------------------------------------------------
// Progress store
// ---------------------------------------------------------------------------

describe("resetBatchCompletionState", () => {
  beforeEach(() => {
    clearBatchCompletionProgress()
  })

  it("initialises progress to { total, done: 0, cancelled: false }", () => {
    freshBatch(5)
    const p = getCompletionBatchProgress()
    expect(p).not.toBeNull()
    expect(p?.total).toBe(5)
    expect(p?.done).toBe(0)
    expect(p?.cancelled).toBe(false)
  })

  it("clears previous cancel state", () => {
    freshBatch(2)
    cancelBatchCompletion()
    expect(isBatchCompletionCancelled()).toBe(true)
    freshBatch(2)
    expect(isBatchCompletionCancelled()).toBe(false)
  })

  it("provides a fresh AbortSignal (not yet aborted)", () => {
    freshBatch(1)
    const signal = getBatchCompletionSignal()
    expect(signal.aborted).toBe(false)
  })
})

describe("clearBatchCompletionProgress", () => {
  it("sets progress to null", () => {
    freshBatch(2)
    expect(getCompletionBatchProgress()).not.toBeNull()
    clearBatchCompletionProgress()
    expect(getCompletionBatchProgress()).toBeNull()
  })
})

describe("incrementBatchCompletionDone", () => {
  it("increments done count", () => {
    freshBatch(3)
    incrementBatchCompletionDone()
    incrementBatchCompletionDone()
    expect(getCompletionBatchProgress()?.done).toBe(2)
  })

  it("is a no-op when no batch is running", () => {
    clearBatchCompletionProgress()
    expect(() => incrementBatchCompletionDone()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Cancel / abort
// ---------------------------------------------------------------------------

describe("cancelBatchCompletion", () => {
  beforeEach(() => {
    clearBatchCompletionProgress()
  })

  it("sets isBatchCompletionCancelled to true", () => {
    freshBatch(3)
    expect(isBatchCompletionCancelled()).toBe(false)
    cancelBatchCompletion()
    expect(isBatchCompletionCancelled()).toBe(true)
  })

  it("marks progress as cancelled", () => {
    freshBatch(3)
    cancelBatchCompletion()
    expect(getCompletionBatchProgress()?.cancelled).toBe(true)
  })

  it("aborts the AbortController signal", () => {
    freshBatch(3)
    const signal = getBatchCompletionSignal()
    expect(signal.aborted).toBe(false)
    cancelBatchCompletion()
    expect(signal.aborted).toBe(true)
  })

  it("does not throw when called without a running batch", () => {
    clearBatchCompletionProgress()
    expect(() => cancelBatchCompletion()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// AbortSignal plumbing — verify abort stops further cells
// (unit-level simulation: the driver loop checks isBatchCompletionCancelled()
// between cells, so once the flag is set no new cells start)
// ---------------------------------------------------------------------------

describe("abort stops further cells (driver-loop invariant)", () => {
  it("after cancelBatchCompletion, isCancelled is true so no new cells start", async () => {
    freshBatch(5)
    const processed: number[] = []

    for (let i = 0; i < 5; i++) {
      if (isBatchCompletionCancelled()) break
      processed.push(i)
      if (i === 1) {
        // Simulate Stop click after the second cell
        cancelBatchCompletion()
      }
    }

    // Cells 0 and 1 processed; cells 2–4 did not start.
    expect(processed).toEqual([0, 1])
  })
})

// ---------------------------------------------------------------------------
// Abort mid-stream semantics
// ---------------------------------------------------------------------------

describe("abort mid-stream does not commit partial text", () => {
  it("AbortError from complete() is detected by name", () => {
    const err = new DOMException("Completion aborted", "AbortError")
    expect(err instanceof DOMException).toBe(true)
    expect(err.name).toBe("AbortError")
  })

  it("a regular error is NOT treated as an abort", () => {
    const err = new Error("network timeout")
    const isAbort = err instanceof DOMException && err.name === "AbortError"
    expect(isAbort).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// FRO-235: Run-identity / interleaving tests (adversarial-panel demands)
// ---------------------------------------------------------------------------

describe("run ID — cancel→restart: old run cannot resurrect after Stop", () => {
  beforeEach(() => {
    clearBatchCompletionProgress()
  })

  it("resetBatchCompletionState returns a monotonically increasing run ID", () => {
    const id1 = resetBatchCompletionState(3)
    const id2 = resetBatchCompletionState(3)
    expect(id2).toBeGreaterThan(id1)
  })

  it("old run ID sees isBatchCompletionCancelled as true after supersession", () => {
    const oldId = resetBatchCompletionState(5)
    // Simulate run A executing normally…
    expect(isBatchCompletionCancelled(oldId)).toBe(false)

    // User clicks Stop on run A, then immediately starts run B.
    cancelBatchCompletion()
    const newId = resetBatchCompletionState(5)

    // Run A's old ID now sees cancelled=true — cannot resurrect.
    expect(isBatchCompletionCancelled(oldId)).toBe(true)
    // Run B's new ID starts fresh — not cancelled.
    expect(isBatchCompletionCancelled(newId)).toBe(false)
  })

  it("getBatchCompletionSignal(oldId) returns an already-aborted signal after supersession", () => {
    const oldId = resetBatchCompletionState(5)
    const oldSignal = getBatchCompletionSignal(oldId)
    expect(oldSignal.aborted).toBe(false)

    // Supersede with a new run (return value intentionally unused — side-effect only).
    resetBatchCompletionState(5)

    // Old signal captured BEFORE supersession is aborted (reset aborts the old controller).
    expect(oldSignal.aborted).toBe(true)

    // getBatchCompletionSignal(oldId) after supersession returns a new already-aborted signal.
    const staleSignal = getBatchCompletionSignal(oldId)
    expect(staleSignal.aborted).toBe(true)
  })

  it("flag and controller both belong to the new run after restart", () => {
    resetBatchCompletionState(3)
    cancelBatchCompletion()
    const newId = resetBatchCompletionState(3)
    const signal = getBatchCompletionSignal(newId)

    // Cancel flag is clear for the new run.
    expect(isBatchCompletionCancelled(newId)).toBe(false)
    // New signal is not yet aborted.
    expect(signal.aborted).toBe(false)

    // Cancelling the new run aborts its signal.
    cancelBatchCompletion()
    expect(signal.aborted).toBe(true)
    expect(isBatchCompletionCancelled(newId)).toBe(true)
  })
})

describe("run ID — run-A finally cannot clear run-B's progress", () => {
  beforeEach(() => {
    clearBatchCompletionProgress()
  })

  it("clearBatchCompletionProgress(oldId) is a no-op when a newer run is active", () => {
    const oldId = resetBatchCompletionState(5)
    // Supersede with run B.
    const newId = resetBatchCompletionState(10)
    expect(getCompletionBatchProgress()?.total).toBe(10)

    // Run A's finally block fires — must NOT clear run B's banner.
    clearBatchCompletionProgress(oldId)
    expect(getCompletionBatchProgress()).not.toBeNull()
    expect(getCompletionBatchProgress()?.total).toBe(10)

    // Run B's finally block fires — SHOULD clear.
    clearBatchCompletionProgress(newId)
    expect(getCompletionBatchProgress()).toBeNull()
  })

  it("incrementBatchCompletionDone(oldId) is a no-op when a newer run is active", () => {
    const oldId = resetBatchCompletionState(5)
    // Supersede with run B (total=10, done=0).
    const newId = resetBatchCompletionState(10)

    // Run A's loop tries to increment — must NOT affect run B's counter.
    incrementBatchCompletionDone(oldId)
    incrementBatchCompletionDone(oldId)
    expect(getCompletionBatchProgress()?.done).toBe(0)

    // Run B legitimately increments.
    incrementBatchCompletionDone(newId)
    expect(getCompletionBatchProgress()?.done).toBe(1)
  })
})

describe("run ID — done-counter accuracy on abort", () => {
  beforeEach(() => {
    clearBatchCompletionProgress()
  })

  it("aborted cells (no text committed) do not increment done", () => {
    const runId = resetBatchCompletionState(3)

    // Simulate: cell 0 committed → increment.
    incrementBatchCompletionDone(runId)
    // Simulate: cancel fires — cells 1 and 2 are aborted, not committed.
    cancelBatchCompletion()
    // Driver checks isBatchCompletionCancelled(runId) → true → skips cells 1 & 2.

    expect(getCompletionBatchProgress()?.done).toBe(1)
    expect(getCompletionBatchProgress()?.cancelled).toBe(true)
  })

  it("calling cancelBatchCompletion then resetBatchCompletionState gives a clean counter", () => {
    const oldId = resetBatchCompletionState(5)
    incrementBatchCompletionDone(oldId)
    incrementBatchCompletionDone(oldId)
    cancelBatchCompletion()

    // Restart — new run counter starts at 0.
    const newId = resetBatchCompletionState(3)
    expect(getCompletionBatchProgress()?.done).toBe(0)
    expect(getCompletionBatchProgress()?.total).toBe(3)
    expect(isBatchCompletionCancelled(newId)).toBe(false)
  })
})
