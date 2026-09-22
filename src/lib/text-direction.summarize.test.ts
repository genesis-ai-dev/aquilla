import { describe, expect, it, vi } from "vitest"
import {
  detectStrongTextDirection,
  summarizeDetectedDirections,
  summarizePairedDirections,
  summarizeTextDirections,
} from "./text-direction"

describe("summarizeDetectedDirections (AQU-1104)", () => {
  it("gives the same answer as summarizeTextDirections over pre-detected directions", () => {
    const values = ["hello", "<b>שלום</b>", "", null]
    const detected = values.map((value) => detectStrongTextDirection(value))
    expect(summarizeDetectedDirections(detected)).toBe("mixed")
    expect(summarizeDetectedDirections(detected)).toBe(summarizeTextDirections(values))
  })

  it("reports a single direction, and null when nothing is strong", () => {
    expect(summarizeDetectedDirections([null, "ltr", null])).toBe("ltr")
    expect(summarizeDetectedDirections([null, "rtl"])).toBe("rtl")
    expect(summarizeDetectedDirections([null, null])).toBeNull()
    expect(summarizeDetectedDirections([])).toBeNull()
  })
})


describe("paired editor direction summaries", () => {
  it("matches independent full summaries for every combination of empty, LTR, RTL and mixed lanes", () => {
    const lanes = [[], [""], ["123"], ["Hello"], ["שלום"], ["<b>عربي</b>", "English"], ["English", "שלום", ""]]
    for (const source of lanes) for (const target of lanes) {
      const cells = Array.from({ length: Math.max(source.length, target.length) }, (_, i) => ({ source: source[i], target: target[i] }))
      expect(summarizePairedDirections(cells, cell => ({
        source: detectStrongTextDirection(cell.source), target: detectStrongTextDirection(cell.target),
      }))).toEqual({ source: summarizeTextDirections(source), target: summarizeTextDirections(target) })
    }
  })

  it("reads each cached cell once and stops only when both lanes are mixed", () => {
    const cells = Array.from({ length: 31_215 }, (_, id) => id)
    const read = vi.fn(() => ({ source: "ltr" as const, target: null }))
    expect(summarizePairedDirections(cells, read)).toEqual({ source: "ltr", target: null })
    expect(read).toHaveBeenCalledTimes(cells.length)
    const mixed = vi.fn((id: number) => ({ source: id % 2 ? "rtl" as const : "ltr" as const, target: id < 3 ? "ltr" as const : "rtl" as const }))
    expect(summarizePairedDirections(cells, mixed)).toEqual({ source: "mixed", target: "mixed" })
    expect(mixed).toHaveBeenCalledTimes(4)
    expect(summarizePairedDirections([], read)).toEqual({ source: null, target: null })
  })
})
