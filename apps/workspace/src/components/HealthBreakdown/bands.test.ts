import { describe, it, expect } from "vitest"
import { reviewedBand, examplesBand, consistencyBand, rulesBand } from "./bands"

describe("reviewedBand", () => {
  it("Fully reviewed when penalty is 0", () => {
    expect(reviewedBand(0, 60)).toBe("Fully reviewed")
  })
  it("Partially reviewed for mid penalties", () => {
    expect(reviewedBand(30, 60)).toBe("Partially reviewed")
  })
  it("Not yet reviewed at max", () => {
    expect(reviewedBand(60, 60)).toBe("Not yet reviewed")
  })
})

describe("examplesBand", () => {
  it("No examples at max penalty", () => {
    expect(examplesBand(20, 20)).toBe("No examples")
  })
  it("Strong lineage at 0", () => {
    expect(examplesBand(0, 20)).toBe("Strong lineage")
  })
  it("Mixed lineage mid-range", () => {
    expect(examplesBand(10, 20)).toBe("Mixed lineage")
  })
})

describe("consistencyBand", () => {
  it("Strong agreement at 0", () => {
    expect(consistencyBand(0, 25)).toBe("Strong agreement")
  })
  it("No neighbors found at max", () => {
    expect(consistencyBand(25, 25)).toBe("No neighbors found")
  })
})

describe("rulesBand", () => {
  it("Clean at 0", () => {
    expect(rulesBand(0, 40, 0)).toBe("Clean")
  })
  it("Minor issues only", () => {
    expect(rulesBand(10, 40, 0)).toBe("Minor issues")
  })
  it("Major issues when any major present", () => {
    expect(rulesBand(15, 40, 1)).toBe("Major issues")
  })
})
