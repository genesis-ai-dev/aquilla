import { describe, expect, it } from "vitest"
import {
  chapterLabelFromCanonical,
  parseScriptureReference,
  verseLabelFromCanonical,
} from "./scripture-reference"

describe("scripture references", () => {
  it("parses canonical refs and resolves the friendly book name", () => {
    expect(parseScriptureReference("MAT 12:4a")).toEqual({
      bookCode: "MAT",
      bookName: "Matthew",
      chapter: "12",
      verse: "4a",
    })
  })

  it("preserves verse ranges for gutter labels", () => {
    expect(verseLabelFromCanonical("GEN 1:1-3")).toBe("1-3")
  })

  it("formats chapter-only section labels", () => {
    expect(chapterLabelFromCanonical("2PE 3")).toBe("2 Peter 3")
  })

  it("does not turn headings or arbitrary rows into verse labels", () => {
    expect(verseLabelFromCanonical("GEN 1:h:1")).toBeNull()
    expect(parseScriptureReference("Row 7")).toBeNull()
  })
})
