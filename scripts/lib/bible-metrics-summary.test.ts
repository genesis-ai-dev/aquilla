// AQU-1690: the before/after summary of autopilot's Bible data metrics. The
// measures must come out per Bible data state, so "off" can be compared with
// "facts+checks" for the same project (design doc §9.6).

import { describe, expect, it } from "vitest"
import { parseSpanMetricsRow, summarizeSpanMetrics, type SpanMetricsRow } from "./bible-metrics-summary"

function row(over: Partial<SpanMetricsRow>): SpanMetricsRow {
  return {
    spanId: "s",
    bibleData: "off",
    units: 0,
    calls: 0,
    construeRounds: null,
    closureExit: null,
    decisionRequired: null,
    bkpFindings: {},
    bkpResidual: {},
    jevCalls: 0,
    judgments: [],
    repaired: 0,
    staged: 0,
    skipped: 0,
    ...over,
  }
}

describe("summarizeSpanMetrics", () => {
  it("compares spans without and with Bible data: rounds, parked questions, findings per 100 cells, Jev answers", () => {
    const summary = summarizeSpanMetrics([
      row({ spanId: "a", units: 60, calls: 8, construeRounds: 4, decisionRequired: "speaker" }),
      row({ spanId: "b", units: 40, calls: 6, construeRounds: 2, staged: 4 }),
      row({
        spanId: "c",
        bibleData: "facts+checks",
        units: 30,
        calls: 5,
        construeRounds: 1,
        staged: 4,
        bkpFindings: { "bkp:V2": 2 },
        bkpResidual: { "bkp:V2": 1 },
        repaired: 2,
        jevCalls: 1,
        judgments: [
          { check: "negation", outcome: "fail", mode: "shadow", decidedBy: "jev", certainty: 0.9 },
          { check: "negation", outcome: "fail", mode: "shadow", decidedBy: "jev", certainty: 0.7 },
        ],
      }),
    ])
    expect(summary.map((g) => g.bibleData)).toEqual(["facts+checks", "off"])
    const [withData, without] = summary
    expect(without).toMatchObject({ spans: 2, meanUnits: 50, meanConstrueRounds: 3, decisionRate: 0.5, speakerDecisionShare: 1 })
    expect(withData).toMatchObject({
      spans: 1,
      meanConstrueRounds: 1,
      decisionRate: 0,
      speakerDecisionShare: null,
      bkpPer100Drafted: 50,
      bkpPer100Staged: 25,
      repairedCells: 2,
      jevCallsPerSpan: 1,
      judgments: { "negation:fail": { count: 2, meanCertainty: 0.8 } },
    })
  })

  it("reads a trace row's JSON, and skips one that is not span metrics", () => {
    expect(parseSpanMetricsRow(JSON.stringify(row({ spanId: "x", bibleData: "facts" })))?.spanId).toBe("x")
    expect(parseSpanMetricsRow("not json")).toBeNull()
    expect(parseSpanMetricsRow(JSON.stringify({ hello: 1 }))).toBeNull()
  })
})
