import { describe, expect, it } from "vitest"
import { flattenSummary, renderReport, type PerfReport } from "./report"
import { summarize } from "./stats"

const baseReport = (overrides: Partial<PerfReport> = {}): PerfReport => ({
  harness: "big-bible",
  startedAt: "2026-10-11T00:00:00.000Z",
  durationMs: 1_000,
  gitSha: "abc1234",
  target: { authBase: "http://127.0.0.1:8788", syncBase: "http://127.0.0.1:8789", appBase: null },
  fixture: {
    projectId: "p1",
    files: 66,
    cells: 31_102,
    measuredFileId: "f1",
    measuredFileName: "PSA.usfm",
    measuredFileCells: 2_500,
  },
  operations: { "cells.read.full": summarize([100, 200, 300]) },
  metrics: { "cells.read.full.p95Ms": 300 },
  skipped: {},
  budgets: null,
  passed: true,
  ...overrides,
})

describe("flattenSummary", () => {
  it("produces the metric keys budgets are written against", () => {
    const metrics = flattenSummary("cells.read.full", summarize([10, 20, 30, 40]))
    expect(metrics).toMatchObject({
      "cells.read.full.count": 4,
      "cells.read.full.p50Ms": 20,
      "cells.read.full.p95Ms": 40,
      "cells.read.full.maxMs": 40,
    })
    expect(metrics["cells.read.full.throughputPerSec"]).toBeUndefined()
  })

  it("includes throughput only for a timed batch", () => {
    const metrics = flattenSummary("events.commit", summarize([10, 10], 1_000))
    expect(metrics["events.commit.throughputPerSec"]).toBe(2)
  })

  it("rounds so a report diff is about real movement", () => {
    expect(flattenSummary("x", summarize([1.23456, 2.34567]))["x.meanMs"]).toBe(1.8)
  })
})

describe("renderReport", () => {
  it("prints a p95 line per operation", () => {
    const text = renderReport(baseReport())
    expect(text).toContain("cells.read.full")
    expect(text).toContain("300ms")
    expect(text).toContain("66 files")
  })

  it("prints long-task counts as their own block", () => {
    const text = renderReport(
      baseReport({ metrics: { "editor.open.longTaskCount": 3, "editor.open.longTaskTotalMs": 410 } }),
    )
    expect(text).toContain("main-thread long tasks")
    expect(text).toContain("editor.open.longTaskCount = 3")
  })

  it("names every breach when a budget is missed", () => {
    const text = renderReport(
      baseReport({
        passed: false,
        budgets: {
          breaches: [
            { metric: "cells.read.full.p95Ms", direction: "max", measured: 900, budget: 500, overBy: 400 },
          ],
          passed: [],
          unmeasured: ["events.commit.p95Ms"],
          unbudgeted: [],
        },
      }),
    )
    expect(text).toContain("BUDGET BREACHES (1)")
    expect(text).toContain("cells.read.full.p95Ms: 900 exceeds max 500")
    expect(text).toContain("unmeasured budgets: events.commit.p95Ms")
  })

  it("says what it skipped, so a thin report is not mistaken for a clean one", () => {
    const text = renderReport(baseReport({ skipped: { "editor.open": "no --app-base given" } }))
    expect(text).toContain("skipped")
    expect(text).toContain("editor.open — no --app-base given")
  })
})
