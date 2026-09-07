import { describe, expect, it } from "vitest"
import {
  detectStrongTextDirection,
  summarizeDetectedDirections,
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
