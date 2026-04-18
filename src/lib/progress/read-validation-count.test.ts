import { describe, it, expect } from "vitest"
import { readValidationCount, readValidationCountAudio } from "./read-validation-count"

describe("readValidationCount", () => {
  it("defaults to 1 when undefined", () => {
    expect(readValidationCount({} as any)).toBe(1)
  })
  it("clamps to min 1", () => {
    expect(readValidationCount({ validationCount: 0 } as any)).toBe(1)
    expect(readValidationCount({ validationCount: -5 } as any)).toBe(1)
  })
  it("clamps to max 15", () => {
    expect(readValidationCount({ validationCount: 99 } as any)).toBe(15)
  })
  it("passes valid values through", () => {
    expect(readValidationCount({ validationCount: 3 } as any)).toBe(3)
  })
  it("handles NaN", () => {
    expect(readValidationCount({ validationCount: NaN } as any)).toBe(1)
  })
})

describe("readValidationCountAudio", () => {
  it("defaults to 1 when undefined", () => {
    expect(readValidationCountAudio({} as any)).toBe(1)
  })
  it("clamps to [1, 15]", () => {
    expect(readValidationCountAudio({ validationCountAudio: 0 } as any)).toBe(1)
    expect(readValidationCountAudio({ validationCountAudio: 20 } as any)).toBe(15)
  })
})
