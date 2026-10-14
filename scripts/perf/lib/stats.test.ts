import { describe, expect, it } from "vitest"
import { percentile, round, runConcurrently, summarize } from "./stats"

describe("percentile", () => {
  it("is nearest-rank, so p95 of 20 samples is the 19th smallest", () => {
    const samples = Array.from({ length: 20 }, (_, i) => i + 1)
    expect(percentile(samples, 95)).toBe(19)
    expect(percentile(samples, 50)).toBe(10)
    expect(percentile(samples, 100)).toBe(20)
  })

  it("does not care about input order", () => {
    expect(percentile([9, 1, 5, 3, 7], 95)).toBe(9)
  })

  it("returns 0 for no samples rather than NaN", () => {
    expect(percentile([], 95)).toBe(0)
  })
})

describe("summarize", () => {
  it("reports the distribution a budget is checked against", () => {
    const summary = summarize([10, 20, 30, 40, 50])
    expect(summary).toMatchObject({
      count: 5,
      minMs: 10,
      p50Ms: 30,
      p95Ms: 50,
      maxMs: 50,
      meanMs: 30,
    })
    expect(summary.elapsedMs).toBeUndefined()
    expect(summary.throughputPerSec).toBeUndefined()
  })

  it("derives throughput only when the caller timed the batch", () => {
    const summary = summarize([5, 5, 5, 5], 2_000)
    expect(summary.elapsedMs).toBe(2_000)
    expect(summary.throughputPerSec).toBe(2)
  })

  it("is safe on an empty sample set", () => {
    expect(summarize([], 100)).toMatchObject({ count: 0, p95Ms: 0, maxMs: 0, throughputPerSec: 0 })
  })
})

describe("runConcurrently", () => {
  it("runs every item and never exceeds the concurrency cap", async () => {
    let inFlight = 0
    let peak = 0
    const seen: number[] = []
    const result = await runConcurrently(12, 4, async (index) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      seen.push(index)
      await Promise.resolve()
      inFlight--
    })
    expect(seen.sort((a, b) => a - b)).toEqual([...Array(12).keys()])
    expect(peak).toBeLessThanOrEqual(4)
    expect(result.samples).toHaveLength(12)
    expect(result.errors).toEqual([])
  })

  it("collects failures instead of aborting the batch", async () => {
    const result = await runConcurrently(4, 2, async (index) => {
      if (index % 2 === 0) throw new Error(`boom ${index}`)
    })
    expect(result.samples).toHaveLength(2)
    expect(result.errors).toEqual(["boom 0", "boom 2"])
  })
})

describe("round", () => {
  it("keeps report numbers readable", () => {
    expect(round(12.3456)).toBe(12.3)
    expect(round(12.3456, 2)).toBe(12.35)
  })
})
