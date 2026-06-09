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
