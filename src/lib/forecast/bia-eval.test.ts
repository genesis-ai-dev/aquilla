// The offline-eval harness on a small synthetic "translation": formulaic
// verses where the right answer depends on a rare word several places away —
// exactly what BIA anchors on and a bigram chain cannot see.

import { describe, expect, it } from "vitest"
import { FAITHFUL, SHIPPED, runForecastEval, splitHeldOut } from "./bia-eval"

const NAMES = ["abram", "isaac", "jacob", "joseph", "moses", "aaron", "joshua", "caleb", "gideon", "samuel"]
const PLACES = ["hebron", "bethel", "shechem", "egypt", "sinai", "jericho", "gilgal", "shiloh", "ramah", "gibeah"]

function corpus(): string[] {
  const lines: string[] = []
  for (let round = 0; round < 6; round++) {
    NAMES.forEach((name, i) => {
      const place = PLACES[(i + round) % PLACES.length]
      // "name" fixes the epithet three words later; the bigram before it is shared.
      lines.push(`then ${name} went up to ${place} and the people of ${name}${i % 2 ? "ites" : "s"} followed`)
      lines.push(`and ${place} was where ${name} built an altar`)
    })
  }
  return lines
}

describe("runForecastEval", () => {
  it("scores next-word and infill for BIA and the baselines on held-out cells", () => {
    const { train, test } = splitHeldOut(corpus(), 5)
    expect(test.length).toBeGreaterThan(0)
    const report = runForecastEval(train, test, { maxPositions: 400 })
    for (const task of [report.next, report.infill]) {
      expect(Object.keys(task)).toEqual(expect.arrayContaining(["unigram", "bigram-markov", FAITHFUL, SHIPPED]))
      for (const acc of Object.values(task)) {
        expect(acc.top3).toBeGreaterThanOrEqual(acc.top1)
        expect(acc.n).toBeGreaterThan(0)
      }
      // The shipped engine must beat raw frequency, and at least match the
      // bigram chain it is built on.
      expect(task[SHIPPED].top1).toBeGreaterThan(task.unigram.top1)
      expect(task[SHIPPED].top3).toBeGreaterThanOrEqual(task["bigram-markov"].top3)
    }
  })

  it("splitHeldOut keeps every kth non-empty line out of training", () => {
    const { train, test } = splitHeldOut(["a", "", "b", "c", "d"], 2)
    expect(test).toEqual(["b", "d"])
    expect(train.map((c) => c.text)).toEqual(["a", "c"])
  })
})
