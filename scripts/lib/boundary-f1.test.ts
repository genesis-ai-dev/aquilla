import { describe, expect, it } from "vitest"
import { scoreBoundaries } from "./boundary-f1"

describe("boundary F1", () => {
  it("scores an exact match perfectly", () => {
    expect(scoreBoundaries([5, 12, 20], [5, 12, 20])).toMatchObject({
      hits: 3,
      precision: 1,
      recall: 1,
      f1: 1,
    })
  })

  it("accepts a boundary one cell out", () => {
    // A pericope suggestion that opens one verse early is still usable.
    expect(scoreBoundaries([4, 13], [5, 12]).hits).toBe(2)
    expect(scoreBoundaries([3, 14], [5, 12]).hits).toBe(0)
  })

  it("honours a wider tolerance when asked", () => {
    expect(scoreBoundaries([3], [5], 2).hits).toBe(1)
    expect(scoreBoundaries([3], [5], 1).hits).toBe(0)
  })

  it("lets one true boundary be claimed only once", () => {
    // Three guesses clustered on one real break: one hit, two false positives.
    // Without one-to-one matching, spraying boundaries everywhere would look
    // like perfect recall at no cost to precision — the failure mode that makes
    // an eval worse than no eval.
    const score = scoreBoundaries([11, 12, 13], [12])
    expect(score.hits).toBe(1)
    expect(score.recall).toBe(1)
    expect(score.precision).toBeCloseTo(1 / 3)
    expect(score.f1).toBeCloseTo(0.5)
  })

  it("does not let a near miss steal the match a closer guess needed", () => {
    // 11 could claim 12, but 12 is exact. Preferring offset 0 first leaves both
    // true boundaries matched instead of one.
    expect(scoreBoundaries([11, 12], [10, 12]).hits).toBe(2)
  })

  it("reports zero rather than dividing by zero", () => {
    expect(scoreBoundaries([], [5])).toMatchObject({ hits: 0, precision: 0, recall: 0, f1: 0 })
    expect(scoreBoundaries([5], [])).toMatchObject({ hits: 0, precision: 0, recall: 0, f1: 0 })
    expect(scoreBoundaries([], [])).toMatchObject({ f1: 0 })
  })

  it("scores unordered predictions the same as ordered ones", () => {
    expect(scoreBoundaries([20, 5, 12], [5, 12, 20])).toEqual(
      scoreBoundaries([5, 12, 20], [5, 12, 20]),
    )
  })
})
