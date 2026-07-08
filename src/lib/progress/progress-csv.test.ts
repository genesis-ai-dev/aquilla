import { describe, it, expect } from "vitest"
import { progressRowsToCsv, progressCsvFilename, type ProgressCsvRow } from "./progress-csv"

// WHY: AQU-500 — a PM copies/downloads the progress table to paste into a
// spreadsheet. If a file name carries a comma, quote, or newline (all legal
// in file names) and we don't escape it per RFC 4180, the paste silently
// shifts columns or splits into extra rows — the PM gets wrong numbers
// without any error. These tests lock in correct CSV escaping.

function row(over: Partial<ProgressCsvRow> = {}): ProgressCsvRow {
  return { name: "Genesis.usfm", filledCount: 5, approvedCount: 2, cellCount: 10, wordCount: 100, ...over }
}

describe("progressRowsToCsv", () => {
  it("emits the header row even for an empty file list", () => {
    expect(progressRowsToCsv([])).toBe("File,Filled,Approved,Total cells,Word count")
  })

  it("serializes a plain row with no special characters unquoted", () => {
    const csv = progressRowsToCsv([row()])
    expect(csv).toBe("File,Filled,Approved,Total cells,Word count\r\nGenesis.usfm,5,2,10,100")
  })

  it("quotes a file name containing a comma", () => {
    const csv = progressRowsToCsv([row({ name: "Genesis, Part 1.usfm" })])
    expect(csv).toContain('"Genesis, Part 1.usfm",5,2,10,100')
  })

  it("quotes and doubles embedded double quotes in a file name", () => {
    const csv = progressRowsToCsv([row({ name: 'The "Good News".usfm' })])
    expect(csv).toContain('"The ""Good News"".usfm",5,2,10,100')
  })

  it("quotes a file name containing a newline", () => {
    const csv = progressRowsToCsv([row({ name: "Genesis\nDraft.usfm" })])
    expect(csv).toContain('"Genesis\nDraft.usfm",5,2,10,100')
  })

  it("quotes a file name containing a carriage return", () => {
    const csv = progressRowsToCsv([row({ name: "Genesis\rDraft.usfm" })])
    expect(csv).toContain('"Genesis\rDraft.usfm",5,2,10,100')
  })

  it("preserves row order and multi-row shape (matches on-screen sort/filter order)", () => {
    const csv = progressRowsToCsv([
      row({ name: "Zeta.usfm", filledCount: 1, approvedCount: 0, cellCount: 4, wordCount: 40 }),
      row({ name: "Alpha.usfm", filledCount: 3, approvedCount: 1, cellCount: 4, wordCount: 40 }),
    ])
    const lines = csv.split("\r\n")
    expect(lines).toEqual([
      "File,Filled,Approved,Total cells,Word count",
      "Zeta.usfm,1,0,4,40",
      "Alpha.usfm,3,1,4,40",
    ])
  })

  it("does not quote fields with no comma/quote/newline even if they contain other punctuation", () => {
    const csv = progressRowsToCsv([row({ name: "40-MAT_v2.usfm" })])
    expect(csv).toContain("40-MAT_v2.usfm,5,2,10,100")
    expect(csv).not.toContain('"40-MAT_v2.usfm"')
  })
})

describe("progressCsvFilename", () => {
  it("sanitizes unsafe characters and appends -progress.csv", () => {
    expect(progressCsvFilename("My Project: Q3 / Draft")).toBe("My-Project-Q3-Draft-progress.csv")
  })

  it("falls back to 'project' when the name sanitizes to empty", () => {
    expect(progressCsvFilename("///")).toBe("project-progress.csv")
  })

  it("keeps a normal name intact aside from spaces", () => {
    expect(progressCsvFilename("Genesis Full")).toBe("Genesis-Full-progress.csv")
  })
})
