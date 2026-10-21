// AQU-1767 (Sam's walk, 2026-10-15): one definition of a take's length and one
// rounding, so the Recording tab, the recorder and the takes lists agree.
import { describe, expect, it } from "vitest"
import { formatTakeSeconds, takePlayedMs } from "./take-length"

describe("takePlayedMs", () => {
  it("is a take's kept part", () => {
    expect(takePlayedMs([{ durationMs: 4000, trimStartMs: 300, trimEndMs: 2700 }])).toBe(2400)
    expect(takePlayedMs([{ durationMs: 4000 }])).toBe(4000)
  })

  it("is a split take's pieces' kept parts summed, not the span they cover", () => {
    expect(takePlayedMs([
      { durationMs: 4000, trimEndMs: 1200 },
      { durationMs: 4000, trimStartMs: 2000, trimEndMs: 3150 },
    ])).toBe(2350)
  })

  it("is null when no length is known", () => {
    expect(takePlayedMs([{}])).toBeNull()
    expect(takePlayedMs([])).toBeNull()
  })
})

describe("formatTakeSeconds", () => {
  it("rounds tenths down, as the recorder's target bar does", () => {
    expect(formatTakeSeconds(2350)).toBe("2.3")
    expect(formatTakeSeconds(2399)).toBe("2.3")
    expect(formatTakeSeconds(2400)).toBe("2.4")
    expect(formatTakeSeconds(4000)).toBe("4.0")
    expect(formatTakeSeconds(0)).toBe("0.0")
  })
})
