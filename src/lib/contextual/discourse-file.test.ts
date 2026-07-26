import { describe, it, expect } from "vitest"
import { isDiscourseFile } from "./discourse-file"

describe("isDiscourseFile", () => {
  it("string-catalog formats are never discourse", () => {
    expect(isDiscourseFile({ type: "json" })).toBe(false)
    expect(isDiscourseFile({ type: "po" })).toBe(false)
    expect(isDiscourseFile({ type: "properties" })).toBe(false)
  })

  it("tabular formats count only with Scripture content", () => {
    expect(isDiscourseFile({ type: "csv" })).toBe(false)
    expect(isDiscourseFile({ type: "tsv" })).toBe(false)
    expect(isDiscourseFile({ type: "xlsx" })).toBe(false)
    expect(isDiscourseFile({ type: "csv", hasScriptureContent: true })).toBe(true)
    expect(isDiscourseFile({ type: "tsv", hasScriptureContent: true })).toBe(true)
  })

  it("discourse formats pass", () => {
    expect(isDiscourseFile({ type: "usfm" })).toBe(true)
    expect(isDiscourseFile({ type: "obs" })).toBe(true)
    expect(isDiscourseFile({ type: "vtt" })).toBe(true)
    expect(isDiscourseFile({ type: "md" })).toBe(true)
    expect(isDiscourseFile({ type: "docx" })).toBe(true)
  })
})
