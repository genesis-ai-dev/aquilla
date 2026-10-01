// AQU-1392: the CSV export is a deliverable a PM pastes into a quote, so the
// escaping and the block layout get direct coverage.
import { describe, it, expect } from "vitest"
import { analysisCsvFilename, analysisReportToCsv, bandLabel } from "./analysis-csv"
import { analyzeFile, buildAnalysisReport, buildFileReport } from "./report"

describe("analysisReportToCsv", () => {
  it("emits the band table, the weighted total and CRLF line endings", () => {
    const csv = analysisReportToCsv(
      buildFileReport({ fileId: "f", name: "Genesis", sources: ["one two three", "one two three"] }),
    )

    expect(csv).toContain("\r\n")
    expect(csv).toContain("Analysis,Genesis")
    expect(csv).toContain("Band,Segments,Words,% of words,Rate,Weighted words")
    expect(csv).toContain("New,1,3,50,1,3")
    expect(csv).toContain("Repetitions,1,3,50,0.3,0.9")
    expect(csv).toContain("Total words,6")
    expect(csv).toContain("Weighted (payable) words,3.9")
    expect(csv).toContain("Saving on word count %,35")
  })

  it("lists every band including the ones no producer fills yet", () => {
    const csv = analysisReportToCsv(buildFileReport({ fileId: "f", name: "F", sources: ["a b"] }))

    expect(csv).toContain("TM 100%,0,0,0,0.3,0")
    expect(csv).toContain("In-context exact (101%),0,0,0,0,0")
  })

  it("appends a per-file breakdown only for a multi-file report", () => {
    const single = analysisReportToCsv(buildFileReport({ fileId: "f", name: "F", sources: ["a b"] }))
    expect(single).not.toContain("New words")

    const project = analysisReportToCsv(
      buildAnalysisReport(
        [
          analyzeFile({ fileId: "a", name: "Genesis", sources: ["one two"] }),
          analyzeFile({ fileId: "b", name: "Exodus", sources: ["three four five"] }),
        ],
        { scope: "project", label: "Bible" },
      ),
    )
    expect(project).toContain("File,Segments,Words,New words,Repetition words,Internal 75-99% words")
    expect(project).toContain("Genesis,1,2,2,0,0")
    expect(project).toContain("Exodus,1,3,3,0,0")
  })

  it("escapes a file name containing a comma or a quote", () => {
    const report = buildAnalysisReport(
      [
        analyzeFile({ fileId: "a", name: 'Luke, "the beloved"', sources: ["one"] }),
        analyzeFile({ fileId: "b", name: "Acts", sources: ["two"] }),
      ],
      { scope: "project", label: "P" },
    )

    expect(analysisReportToCsv(report)).toContain('"Luke, ""the beloved""",1,1,1,0,0')
  })
})

describe("analysisCsvFilename", () => {
  it("sanitizes the label into a filesystem-safe name", () => {
    expect(analysisCsvFilename("Burmese NT")).toBe("Burmese-NT-analysis.csv")
    expect(analysisCsvFilename("  ")).toBe("project-analysis.csv")
    expect(analysisCsvFilename("a/b:c")).toBe("a-b-c-analysis.csv")
  })
})

describe("bandLabel", () => {
  it("names every band and falls back to the raw key", () => {
    expect(bandLabel("internal_75_99")).toBe("Internal fuzzy 75–99%")
    expect(bandLabel("nope")).toBe("nope")
  })
})
