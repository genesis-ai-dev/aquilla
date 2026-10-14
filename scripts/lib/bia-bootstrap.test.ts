import { describe, expect, it } from "vitest"
import { pairedBootstrap, seededRandom, verdict } from "./bia-bootstrap"

describe("pairedBootstrap", () => {
  it("reports the observed paired difference in points", () => {
    // 4 verses × 2 positions; A hits everything, B hits half.
    const verse = [0, 0, 1, 1, 2, 2, 3, 3]
    const a = [3, 3, 3, 3, 3, 3, 3, 3]
    const b = [3, 0, 3, 0, 3, 0, 3, 0]
    const r = pairedBootstrap(verse, a, b, 1, { resamples: 500 })
    expect(r.diff).toBeCloseTo(50)
    expect(r.verses).toBe(4)
    // Every verse has the same difference, so every resample does too.
    expect(r.lo).toBeCloseTo(50)
    expect(r.hi).toBeCloseTo(50)
    expect(verdict(r)).toBe("real")
  })

  it("calls identical methods noise and is deterministic for a seed", () => {
    const verse = Array.from({ length: 200 }, (_, i) => Math.floor(i / 4))
    const random = seededRandom(7)
    const a = verse.map(() => (random() < 0.3 ? 3 : random() < 0.5 ? 2 : 0))
    const r1 = pairedBootstrap(verse, a, a, 1)
    expect(r1).toEqual({ diff: 0, lo: 0, hi: 0, verses: 50 })
    expect(verdict(r1)).toBe("noise")
    const b = verse.map(() => (random() < 0.3 ? 3 : 0))
    expect(pairedBootstrap(verse, a, b, 2, { seed: 3 })).toEqual(pairedBootstrap(verse, a, b, 2, { seed: 3 }))
  })

  it("selects top-1 or top-3 by bit and rejects misaligned input", () => {
    const verse = [0, 1]
    expect(pairedBootstrap(verse, [2, 2], [0, 0], 1).diff).toBe(0)
    expect(pairedBootstrap(verse, [2, 2], [0, 0], 2).diff).toBe(100)
    expect(() => pairedBootstrap([0], [1, 1], [1, 1], 1)).toThrow()
  })
})
