// AQU-1392. These tests guard the report's acceptance criteria directly:
// repetition-not-new, CJK per character, project roll-up, and the rate card
// staying visible when a band has no producer.
import { describe, it, expect } from "vitest"
import {
  analyzeFile,
  buildAnalysisReport,
  buildFileReport,
  emptyBandTotals,
  PRODUCED_BANDS,
  UNPOPULATED_BANDS,
} from "./report"
import { DEFAULT_RATES } from "./payable"

const bandRow = (report: ReturnType<typeof buildAnalysisReport>, band: string) => {
  const row = report.bands.find((b) => b.band === band)
  if (!row) throw new Error(`no row for band ${band}`)
  return row
}

describe("analyzeFile", () => {
  it("counts the first occurrence as new and every later identical one as a repetition", () => {
    const analysis = analyzeFile({
      fileId: "f1",
      name: "Genesis",
      sources: ["In the beginning", "In the beginning", "In the beginning"],
    })

    expect(analysis.segmentsPerBand.new).toBe(1)
    expect(analysis.segmentsPerBand.repetition).toBe(2)
    expect(analysis.wordsPerBand.new).toBe(3)
    expect(analysis.wordsPerBand.repetition).toBe(6)
    expect(analysis.words).toBe(9)
    expect(analysis.segments).toBe(3)
  })

  it("treats a normalized duplicate (case/whitespace) as a repetition", () => {
    const analysis = analyzeFile({
      fileId: "f1",
      name: "f",
      sources: ["The  LORD is my shepherd", "the lord is my shepherd"],
    })

    expect(analysis.segmentsPerBand.new).toBe(1)
    expect(analysis.segmentsPerBand.repetition).toBe(1)
  })

  it("bands a near-duplicate as internal fuzzy rather than new", () => {
    const analysis = analyzeFile({
      fileId: "f1",
      name: "f",
      sources: [
        "and God said let there be light and there was light",
        "and God said let there be water and there was light",
      ],
    })

    expect(analysis.segmentsPerBand.new).toBe(1)
    expect(analysis.segmentsPerBand.internal_75_99).toBe(1)
    expect(analysis.segmentsPerBand.repetition).toBe(0)
  })

  it("counts CJK text per character", () => {
    // Four Han characters, no spaces — a space-delimited count would say 1.
    const analysis = analyzeFile({ fileId: "f1", name: "f", sources: ["起初神创造"] })

    expect(analysis.words).toBe(5)
    expect(analysis.wordsPerBand.new).toBe(5)
  })

  it("ignores empty segments in the word total but still counts them as segments", () => {
    const analysis = analyzeFile({ fileId: "f1", name: "f", sources: ["hello world", "   "] })

    expect(analysis.segments).toBe(2)
    expect(analysis.words).toBe(2)
  })

  it("leaves every band that has no producer at zero", () => {
    const analysis = analyzeFile({ fileId: "f1", name: "f", sources: ["a b c"] })

    for (const band of UNPOPULATED_BANDS) expect(analysis.wordsPerBand[band]).toBe(0)
  })
})

describe("buildAnalysisReport", () => {
  it("sums per-file bands rather than re-bucketing across files", () => {
    // The same sentence in two files is new in each: a per-file quote cannot
    // discount work that a translator does twice in two documents.
    const a = analyzeFile({ fileId: "a", name: "A", sources: ["one two three"] })
    const b = analyzeFile({ fileId: "b", name: "B", sources: ["one two three"] })

    const report = buildAnalysisReport([a, b], { scope: "project", label: "P" })

    expect(bandRow(report, "new").segments).toBe(2)
    expect(bandRow(report, "repetition").segments).toBe(0)
    expect(report.totalWords).toBe(6)
    expect(report.totalSegments).toBe(2)
    expect(report.files).toHaveLength(2)
  })

  it("weights the total by the default rates and reports the saving", () => {
    // 3 new words @1.0 + 3 repeated words @0.3 = 3.9 payable of 6 raw.
    const report = buildFileReport({ fileId: "f", name: "F", sources: ["one two three", "one two three"] })

    expect(report.totalWords).toBe(6)
    expect(report.payableWords).toBe(3.9)
    expect(report.discountPct).toBe(35)
    expect(bandRow(report, "repetition").rate).toBe(DEFAULT_RATES.repetition)
    expect(bandRow(report, "repetition").payableWords).toBe(0.9)
  })

  it("reports every band — produced and not — so the rate card is checkable", () => {
    const report = buildFileReport({ fileId: "f", name: "F", sources: ["a b"] })

    expect(report.bands.map((b) => b.band)).toEqual([...PRODUCED_BANDS, ...UNPOPULATED_BANDS])
    for (const band of UNPOPULATED_BANDS) {
      const row = bandRow(report, band)
      expect(row.words).toBe(0)
      expect(row.unpopulated).toBe(true)
    }
    for (const band of PRODUCED_BANDS) expect(bandRow(report, band).unpopulated).toBe(false)
  })

  it("expresses each band as a percentage of total words", () => {
    const report = buildFileReport({ fileId: "f", name: "F", sources: ["one two three", "one two three"] })

    expect(bandRow(report, "new").pctOfWords).toBe(50)
    expect(bandRow(report, "repetition").pctOfWords).toBe(50)
  })

  it("does not divide by zero on an empty project", () => {
    const report = buildAnalysisReport([], { scope: "project", label: "Empty" })

    expect(report.totalWords).toBe(0)
    expect(report.payableWords).toBe(0)
    expect(report.discountPct).toBe(0)
    expect(report.bands.every((b) => b.pctOfWords === 0)).toBe(true)
  })

  it("honours a custom rate table", () => {
    const rates = { ...DEFAULT_RATES, repetition: 0 }
    const report = buildAnalysisReport(
      [analyzeFile({ fileId: "f", name: "F", sources: ["one two three", "one two three"] })],
      { scope: "file", label: "F", rates },
    )

    expect(report.payableWords).toBe(3)
    expect(bandRow(report, "repetition").payableWords).toBe(0)
  })
})

describe("emptyBandTotals", () => {
  it("zeroes every band and hands back a fresh object each call", () => {
    const a = emptyBandTotals()
    a.new = 5
    expect(emptyBandTotals().new).toBe(0)
    expect(Object.values(emptyBandTotals()).every((v) => v === 0)).toBe(true)
  })
})
