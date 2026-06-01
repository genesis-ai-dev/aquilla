import { describe, it, expect } from "vitest"
import { concatPcm } from "./audio-by-character"

describe("concatPcm", () => {
  it("joins clips back-to-back in order", () => {
    const out = concatPcm([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([4, 5])])
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5])
  })

  it("returns an empty array for no clips", () => {
    expect(concatPcm([]).length).toBe(0)
  })
})
