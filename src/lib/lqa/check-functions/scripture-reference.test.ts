import { describe, it, expect } from "vitest"
import { runCheck, scanReferences } from "./scripture-reference"
import type { ProjectBookName } from "../builtin-run-context"

// AQU-1735 acceptance criteria, in order:
//   - "Jn 3:17" in a project whose book-name table says "Jhn" is flagged;
//   - a reference to Psalm 151 in a Protestant-canon project is flagged.
// (The first criterion — a target-only number — is the `number-integrity-extra`
// check, AQU-1761, and is covered by its own suite.)

const PROJECT_SAYS_JHN: ProjectBookName[] = [{ code: "JHN", names: ["Jhn"] }]

describe("scripture-reference", () => {
  describe("the project's book names", () => {
    it("flags an abbreviation the project does not use", () => {
      const spans = runCheck("", "See Jn 3:17 for the promise.", { bookNames: PROJECT_SAYS_JHN })
      expect(spans).toHaveLength(1)
      expect(spans?.[0]).toMatchObject({ side: "target", matchedText: "Jn 3:17" })
    })

    it("accepts the project's own spelling", () => {
      expect(runCheck("", "See Jhn 3:17.", { bookNames: PROJECT_SAYS_JHN })).toBeNull()
    })

    it("accepts the book's USFM code, which every project spells its files with", () => {
      expect(runCheck("", "See JHN 3:17.", { bookNames: PROJECT_SAYS_JHN })).toBeNull()
    })

    it("says nothing about a book the project's table does not cover", () => {
      // The project imported John only, so it has no opinion on Romans.
      expect(runCheck("", "See Rom 1:17.", { bookNames: PROJECT_SAYS_JHN })).toBeNull()
    })

    it("judges no spelling when the project has no table", () => {
      expect(runCheck("", "See Jn 3:17.")).toBeNull()
      expect(runCheck("", "See Jn 3:17.", { bookNames: [] })).toBeNull()
    })

    it("flags every offending reference in the cell, at its own position", () => {
      const target = "Jhn 3:16 and Jn 3:17"
      const spans = runCheck("", target, { bookNames: PROJECT_SAYS_JHN })
      expect(spans).toHaveLength(1)
      const span = spans![0]
      expect(target.slice(span.start, span.end)).toBe("Jn 3:17")
    })
  })

  describe("the canon", () => {
    it("flags a chapter the canon does not have", () => {
      const spans = runCheck("", "Psalm 151:1 is not in the canon.")
      expect(spans).toHaveLength(1)
      expect(spans?.[0].matchedText).toBe("Psalm 151:1")
    })

    it("accepts the book's last chapter", () => {
      expect(runCheck("", "Psalm 150:6 praises him.")).toBeNull()
    })

    it("flags an out-of-range chapter even without a project table", () => {
      expect(runCheck("", "Jude 2:1")).not.toBeNull()
    })
  })

  describe("separator consistency", () => {
    it("flags a reference that separates chapter and verse differently from the first", () => {
      const spans = runCheck("", "See Jhn 3:16 and Rom 1.17.")
      expect(spans).toHaveLength(1)
      expect(spans?.[0].matchedText).toBe("Rom 1.17")
    })

    it("accepts a cell that uses one separator throughout", () => {
      expect(runCheck("", "See Jhn 3.16 and Rom 1.17.")).toBeNull()
    })
  })

  describe("what is not a reference", () => {
    it("ignores a reference-shaped run whose first word names no book", () => {
      expect(runCheck("", "See Section 3:17 of the handbook.", { bookNames: PROJECT_SAYS_JHN })).toBeNull()
      expect(runCheck("", "The meeting is at 3:16 pm.", { bookNames: PROJECT_SAYS_JHN })).toBeNull()
    })

    it("ignores a lowercase word that happens to abbreviate a book", () => {
      expect(scanReferences("I am 3:16 now")).toEqual([])
    })

    it("returns null for a cell with no references at all", () => {
      expect(runCheck("In the beginning", "Au commencement", { bookNames: PROJECT_SAYS_JHN })).toBeNull()
    })
  })

  describe("scanReferences", () => {
    it("reads an ordinal book name and a verse range", () => {
      expect(scanReferences("1 Samuel 3:2-4")).toMatchObject([
        { bookCode: "1SA", chapter: 3, separator: ":", bookText: "1 Samuel" },
      ])
    })

    it("reads the full English name and a short form alike", () => {
      expect(scanReferences("John 3:16").map((r) => r.bookCode)).toEqual(["JHN"])
      expect(scanReferences("Mt 5:3").map((r) => r.bookCode)).toEqual(["MAT"])
    })
  })
})
