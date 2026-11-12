import { describe, expect, it } from "vitest"
import { evaluateBudgets, parseBudgetFile, renderBreaches } from "./budgets"
import budgetsJson from "../budgets.json"

describe("parseBudgetFile", () => {
  it("accepts a file with only one direction", () => {
    expect(parseBudgetFile({ max: { "a.p95Ms": 10 } })).toEqual({ max: { "a.p95Ms": 10 }, min: {} })
  })

  it("rejects a non-numeric budget, naming the key", () => {
    expect(() => parseBudgetFile({ max: { "a.p95Ms": "fast" } })).toThrow(/max\.a\.p95Ms/)
  })

  it("rejects a metric budgeted in both directions", () => {
    expect(() => parseBudgetFile({ max: { x: 1 }, min: { x: 1 } })).toThrow(/both max and min/)
  })

  it("rejects an empty budget set — a harness that checks nothing passes everything", () => {
    expect(() => parseBudgetFile({})).toThrow(/declares no budgets/)
  })

  it("accepts the committed budgets.json", () => {
    const parsed = parseBudgetFile(budgetsJson)
    expect(Object.keys(parsed.max).length).toBeGreaterThan(0)
  })
})

describe("evaluateBudgets", () => {
  const budgets = parseBudgetFile({
    max: { "cells.read.full.p95Ms": 2_000, "editor.open.longTaskCount": 5 },
    min: { "events.commit.throughputPerSec": 4 },
  })

  it("passes a run inside every budget", () => {
    const result = evaluateBudgets(
      {
        "cells.read.full.p95Ms": 1_500,
        "editor.open.longTaskCount": 2,
        "events.commit.throughputPerSec": 9,
      },
      budgets,
    )
    expect(result.breaches).toEqual([])
    expect(result.unmeasured).toEqual([])
    expect(result.passed).toHaveLength(3)
  })

  it("flags a max breach with how far over it went", () => {
    const result = evaluateBudgets({ "cells.read.full.p95Ms": 2_750 }, budgets)
    expect(result.breaches).toEqual([
      {
        metric: "cells.read.full.p95Ms",
        direction: "max",
        measured: 2_750,
        budget: 2_000,
        overBy: 750,
      },
    ])
  })

  it("flags a min breach when throughput drops below the floor", () => {
    const result = evaluateBudgets({ "events.commit.throughputPerSec": 1.5 }, budgets)
    expect(result.breaches.map((b) => b.metric)).toEqual(["events.commit.throughputPerSec"])
    expect(result.breaches[0]).toMatchObject({ direction: "min", overBy: 2.5 })
  })

  it("treats exactly-at-budget as a pass, not a breach", () => {
    const result = evaluateBudgets(
      { "cells.read.full.p95Ms": 2_000, "events.commit.throughputPerSec": 4 },
      budgets,
    )
    expect(result.breaches).toEqual([])
  })

  it("reports a budgeted metric the run never measured", () => {
    const result = evaluateBudgets({ "cells.read.full.p95Ms": 10 }, budgets)
    expect(result.unmeasured).toEqual(["editor.open.longTaskCount", "events.commit.throughputPerSec"])
  })

  it("reports measured-but-unbudgeted metrics without failing them", () => {
    const result = evaluateBudgets({ "something.newMs": 999_999 }, budgets)
    expect(result.unbudgeted).toEqual(["something.newMs"])
    expect(result.breaches).toEqual([])
  })
})

describe("renderBreaches", () => {
  it("says which direction was missed", () => {
    const lines = renderBreaches([
      { metric: "a.p95Ms", direction: "max", measured: 10, budget: 5, overBy: 5 },
      { metric: "b.perSec", direction: "min", measured: 1, budget: 4, overBy: 3 },
    ])
    expect(lines[0]).toContain("exceeds max")
    expect(lines[1]).toContain("below min")
  })
})
