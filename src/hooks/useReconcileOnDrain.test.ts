import { describe, it, expect, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useReconcileOnDrain } from "./useReconcileOnDrain"

describe("useReconcileOnDrain", () => {
  it("fires onDrained once when count falls from >0 to 0", () => {
    const onDrained = vi.fn()
    const { rerender } = renderHook(({ n }) => useReconcileOnDrain(n, onDrained), {
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
    const { rerender } = renderHook(({ n }) => useReconcileOnDrain(n, onDrained), {
      initialProps: { n: 0 },
    })
    rerender({ n: 0 })
    rerender({ n: 0 })
    expect(onDrained).not.toHaveBeenCalled()
  })

  it("fires again on a second queue→drain cycle", () => {
    const onDrained = vi.fn()
    const { rerender } = renderHook(({ n }) => useReconcileOnDrain(n, onDrained), {
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
    const { rerender } = renderHook(({ n }) => useReconcileOnDrain(n, onDrained), {
      initialProps: { n: 5 },
    })
    rerender({ n: 2 })
    expect(onDrained).not.toHaveBeenCalled()
    rerender({ n: 0 })
    expect(onDrained).toHaveBeenCalledTimes(1)
  })
})
