// AQU-1098: which sections belong to which planning unit.
import { describe, it, expect } from "vitest"
import { sectionBelongsToUnit, unplacedLines } from "./usePlanUnitSections"

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

describe("unplacedLines (AQU-1493)", () => {
  const s = (key: string, totalCount: number) => ({ key, totalCount })

  it("counts the lines no chapter holds, and says a one-book file's book holds them", () => {
    // Genesis: 40 + 38 verses in chapters, three lines added in the editor.
    expect(unplacedLines(81, [s("GEN 1", 40), s("GEN 2", 38)])).toEqual({ count: 3, inUnit: true })
    // Front matter keys by its bare book code; it is in the book, not unplaced.
    expect(unplacedLines(81, [s("GEN", 3), s("GEN 1", 40), s("GEN 2", 38)])).toEqual({ count: 0, inUnit: true })
  })

  it("says no book holds them in a file of several books", () => {
    expect(unplacedLines(12, [s("GEN 1", 5), s("EXO 1", 5)])).toEqual({ count: 2, inUnit: false })
  })

  it("counts a timed line with no reference as having no verse either", () => {
    expect(unplacedLines(12, [s("GEN 1", 10), s("t:000000000000", 2)])).toEqual({ count: 2, inUnit: true })
  })

  it("never goes negative on a response whose rows disagree", () => {
    expect(unplacedLines(5, [s("GEN 1", 10)]).count).toBe(0)
  })
})
