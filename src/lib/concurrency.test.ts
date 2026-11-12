import { describe, it, expect, vi } from "vitest"
import { mapWithConcurrency } from "./concurrency"

describe("mapWithConcurrency", () => {
  it("returns results in input order, not completion order", async () => {
    const out = await mapWithConcurrency([30, 1, 20, 2], 4, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms))
      return `${i}:${ms}`
    })
    expect(out).toEqual(["0:30", "1:1", "2:20", "3:2"])
  })

  it("keeps at most `concurrency` calls in flight", async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
    })
    expect(peak).toBe(3)
  })

  it("handles an empty list without spawning a worker", async () => {
    const fn = vi.fn()
    expect(await mapWithConcurrency([], 4, fn)).toEqual([])
    expect(fn).not.toHaveBeenCalled()
  })

  it("rethrows the first rejection and stops scheduling new work", async () => {
    const started: number[] = []
    await expect(
      mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 2, async (i) => {
        started.push(i)
        await new Promise((resolve) => setTimeout(resolve, 1))
        if (i === 1) throw new Error("boom")
        return i
      }),
    ).rejects.toThrow("boom")
    // The two workers were in flight when one failed; the other finishes its
    // current item but no further items are picked up.
    expect(started.length).toBeLessThan(10)
  })

  it("never spawns more workers than items, whatever the cap", async () => {
    let peak = 0
    let inFlight = 0
    await mapWithConcurrency([1, 2], 50, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
    })
    expect(peak).toBe(2)
  })
})
