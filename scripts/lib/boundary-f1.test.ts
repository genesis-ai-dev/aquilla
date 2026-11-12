import { describe, expect, it } from "vitest"
import { scoreBoundaries, scoreBoundaryTimes } from "./boundary-f1"

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

describe("boundary F1 in the time domain", () => {
  it("scores an exact match perfectly", () => {
    expect(scoreBoundaryTimes([1_000, 60_000], [1_000, 60_000], 3_000)).toMatchObject({
      hits: 2,
      precision: 1,
      recall: 1,
      f1: 1,
    })
  })

  it("accepts a boundary inside the tolerance and rejects one outside it", () => {
    expect(scoreBoundaryTimes([62_500], [60_000], 3_000).hits).toBe(1)
    expect(scoreBoundaryTimes([64_000], [60_000], 3_000).hits).toBe(0)
    expect(scoreBoundaryTimes([64_000], [60_000], 10_000).hits).toBe(1)
  })

  it("matches one-to-one, so a cluster of guesses banks one hit", () => {
    const score = scoreBoundaryTimes([59_000, 60_000, 61_000], [60_000], 3_000)
    expect(score.hits).toBe(1)
    expect(score.recall).toBe(1)
    expect(score.precision).toBeCloseTo(1 / 3)
  })

  it("gives a true boundary to its nearest prediction", () => {
    // 10_500 is nearer to 10_000 than 12_500 is, and both are in tolerance;
    // claiming it for the further one would lose the second hit.
    expect(scoreBoundaryTimes([10_500, 12_500], [10_000, 13_000], 3_000).hits).toBe(2)
  })

  it("scores zero rather than dividing by zero when a side is empty", () => {
    expect(scoreBoundaryTimes([], [10_000], 3_000)).toMatchObject({ hits: 0, f1: 0 })
    expect(scoreBoundaryTimes([10_000], [], 3_000)).toMatchObject({ hits: 0, f1: 0 })
  })
})
