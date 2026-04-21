import { describe, it, expect } from "vitest"
import { validationGap } from "./validation-gap"

describe("validationGap", () => {
  it("returns the full cap when activeCount is 0", () => {
    expect(validationGap(0, 2, 60)).toBe(60)
  })
  it("returns 0 when activeCount equals required", () => {
    expect(validationGap(2, 2, 60)).toBe(0)
  })
  it("returns 0 when activeCount exceeds required (clamped)", () => {
    expect(validationGap(5, 2, 60)).toBe(0)
  })
  it("scales linearly between 0 and cap", () => {
    expect(validationGap(1, 2, 60)).toBe(30)
  })
  it("treats requiredValidations ≤ 0 as 1 to avoid div-by-zero", () => {
    expect(validationGap(0, 0, 60)).toBe(60)
    expect(validationGap(1, 0, 60)).toBe(0)
  })
})
