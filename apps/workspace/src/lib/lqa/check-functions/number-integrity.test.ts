import { describe, it, expect } from "vitest"
import { runCheck } from "./number-integrity"

describe("number-integrity", () => {
  it("returns null when all source numbers appear in target", () => {
    expect(runCheck("12 hours, 3 minutes", "12 heures, 3 minutes")).toBeNull()
  })

  it("tolerates locale separators (1,000 vs 1.000)", () => {
    expect(runCheck("Population: 1,000,000", "Población: 1.000.000")).toBeNull()
  })

  it("flags missing number", () => {
    const spans = runCheck("3 days, 12 hours", "trois jours")
    expect(spans).not.toBeNull()
    expect(spans!.some(s => s.matchedText === "12")).toBe(true)
  })

  it("returns null when source has no numbers", () => {
    expect(runCheck("Hello world", "Bonjour")).toBeNull()
  })

  it("matches negative numbers", () => {
    expect(runCheck("Drop of -5 degrees", "Caída de -5 grados")).toBeNull()
    expect(runCheck("Drop of -5 degrees", "Caída de 5 grados")).not.toBeNull()
  })

  it("does not double-count duplicates", () => {
    expect(runCheck("5 and 5", "cinco y 5")).toBeNull()
  })
})
