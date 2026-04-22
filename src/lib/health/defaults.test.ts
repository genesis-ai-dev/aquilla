import { describe, it, expect } from "vitest"
import { HEALTH_DEFAULTS } from "./defaults"

describe("HEALTH_DEFAULTS", () => {
  it("has validationGap cap 60", () => {
    expect(HEALTH_DEFAULTS.caps.validationGap).toBe(60)
  })
  it("has ancestryPenalty cap 20", () => {
    expect(HEALTH_DEFAULTS.caps.ancestryPenalty).toBe(20)
  })
  it("has neighborhoodPenalty cap 25", () => {
    expect(HEALTH_DEFAULTS.caps.neighborhoodPenalty).toBe(25)
  })
  it("has rulePenalty cap 40", () => {
    expect(HEALTH_DEFAULTS.caps.rulePenalty).toBe(40)
  })
  it("has equal neighborhood weights summing > 0", () => {
    const { idJaccard, tfidfTokenOverlap } = HEALTH_DEFAULTS.neighborhoodWeights
    expect(idJaccard).toBe(0.5)
    expect(tfidfTokenOverlap).toBe(0.5)
  })
  it("has rulePenalties { major: 15, minor: 5 }", () => {
    expect(HEALTH_DEFAULTS.rulePenalties).toEqual({ major: 15, minor: 5 })
  })
  it("has neighborhoodSearchLimit 5", () => {
    expect(HEALTH_DEFAULTS.neighborhoodSearchLimit).toBe(5)
  })
})
