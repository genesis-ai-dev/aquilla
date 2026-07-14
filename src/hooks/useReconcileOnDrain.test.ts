import { describe, it, expect, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useReconcileOnDrain } from "./useReconcileOnDrain"

describe("useReconcileOnDrain", () => {
  it("fires onDrained once when count falls from >0 to 0", () => {
    const onDrained = vi.fn()
    const { rerender } = renderHook(({ n }) => useReconcileOnDrain(n, "f1", onDrained), {
      initialProps: { n: 0 },
    })
    expect(onDrained).not.toHaveBeenCalled() // starting at 0 is not a drain
    rerender({ n: 5 }) // queued
    expect(onDrained).not.toHaveBeenCalled()
    rerender({ n: 0 }) // drained
    expect(onDrained).toHaveBeenCalledTimes(1)
  })

  it("does not fire on a steady zero, only on the >0 → 0 transition", () => {
    const onDrained = vi.fn()
    const { rerender } = renderHook(({ n }) => useReconcileOnDrain(n, "f1", onDrained), {
      initialProps: { n: 0 },
    })
    rerender({ n: 0 })
    rerender({ n: 0 })
    expect(onDrained).not.toHaveBeenCalled()
  })

  it("fires again on a second queue→drain cycle", () => {
    const onDrained = vi.fn()
    const { rerender } = renderHook(({ n }) => useReconcileOnDrain(n, "f1", onDrained), {
      initialProps: { n: 0 },
    })
    rerender({ n: 3 })
    rerender({ n: 0 })
    rerender({ n: 2 })
    rerender({ n: 0 })
    expect(onDrained).toHaveBeenCalledTimes(2)
  })

  it("does not fire while the count is still draining (e.g. 5 → 2)", () => {
    const onDrained = vi.fn()
    const { rerender } = renderHook(({ n }) => useReconcileOnDrain(n, "f1", onDrained), {
      initialProps: { n: 5 },
    })
    rerender({ n: 2 })
    expect(onDrained).not.toHaveBeenCalled()
    rerender({ n: 0 })
    expect(onDrained).toHaveBeenCalledTimes(1)
  })

  // Intent: switching the active file while another file still has pending
  // commits must NOT read as a drain. The count drops N→0 only because the memo
  // now filters to the new (empty) file — no work actually flushed, so a soft
  // revalidate here would be spurious.
  it("does not fire when the key (active file) changes and count drops to 0", () => {
    const onDrained = vi.fn()
    const { rerender } = renderHook(
      ({ n, key }) => useReconcileOnDrain(n, key, onDrained),
      { initialProps: { n: 4, key: "fileA" } },
    )
    // File A has 4 pending commits; user switches to File B which has none.
    rerender({ n: 0, key: "fileB" })
    expect(onDrained).not.toHaveBeenCalled()
  })

  it("still fires on a genuine drain of the same file after a switch", () => {
    const onDrained = vi.fn()
    const { rerender } = renderHook(
      ({ n, key }) => useReconcileOnDrain(n, key, onDrained),
      { initialProps: { n: 4, key: "fileA" } },
    )
    rerender({ n: 0, key: "fileB" }) // switch, no fire
    rerender({ n: 3, key: "fileB" }) // File B queues its own commits
    rerender({ n: 0, key: "fileB" }) // and drains them
    expect(onDrained).toHaveBeenCalledTimes(1)
  })
})
