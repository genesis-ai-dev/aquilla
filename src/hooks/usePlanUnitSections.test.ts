// AQU-1098: which sections belong to which planning unit.
import { describe, it, expect } from "vitest"
import { sectionBelongsToUnit } from "./usePlanUnitSections"

describe("sectionBelongsToUnit", () => {
  it("takes the chapters of the book it was asked for", () => {
    expect(sectionBelongsToUnit("GEN 1", "GEN")).toBe(true)
    expect(sectionBelongsToUnit("GEN 40", "GEN")).toBe(true)
  })

  it("takes a one-chapter book whose section key IS the book code", () => {
    // "TIT" makes the section key and the book key identical, so a prefix
    // test alone would drop the only chapter Titus has.
    expect(sectionBelongsToUnit("TIT", "TIT")).toBe(true)
  })

  it("refuses a different book that merely shares a prefix", () => {
    // "GEN" must not swallow a hypothetical "GENX 1"; the space is required.
    expect(sectionBelongsToUnit("GENX 1", "GEN")).toBe(false)
    expect(sectionBelongsToUnit("EXO 1", "GEN")).toBe(false)
  })

  it("gives a file-grain unit every section in the file", () => {
    expect(sectionBelongsToUnit("GEN 1", "")).toBe(true)
    expect(sectionBelongsToUnit("Scene 4", "")).toBe(true)
  })

  it("never lists a media file's time buckets", () => {
    // "t:3" is a five-minute wall-clock bucket. Nobody plans by one, and a
    // column of them reads as meaningless numbers.
    expect(sectionBelongsToUnit("t:3", "")).toBe(false)
    expect(sectionBelongsToUnit("t:3", "GEN")).toBe(false)
  })
})
