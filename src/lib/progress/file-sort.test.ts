import { describe, it, expect } from "vitest"
import { sortFiles, filterFilesByName, FILE_SORT_MODES, type FileSortMode } from "./file-sort"

interface F {
  name: string
  lastEditAt: number | null
}

function f(name: string, lastEditAt: number | null): F {
  return { name, lastEditAt }
}

describe("FILE_SORT_MODES", () => {
  it("exposes exactly last-updated, canonical, alphabetical in that order", () => {
    expect(FILE_SORT_MODES.map((m) => m.value)).toEqual<FileSortMode[]>([
      "last-updated",
      "canonical",
      "alphabetical",
    ])
  })
})

describe("sortFiles — last-updated (default)", () => {
  it("orders most-recently-progressed first", () => {
    const files = [f("A", 100), f("B", 300), f("C", 200)]
    expect(sortFiles(files, "last-updated").map((x) => x.name)).toEqual(["B", "C", "A"])
  })

  it("sorts null lastEditAt last, after all timestamped files", () => {
    const files = [f("A", null), f("B", 50), f("C", null), f("D", 10)]
    const result = sortFiles(files, "last-updated")
    expect(result.map((x) => x.name)).toEqual(["B", "D", "A", "C"])
  })

  it("breaks ties (including all-null) alphabetically by name", () => {
    const files = [f("Zebra", null), f("Alpha", null), f("Mid", 5), f("Beta", 5)]
    // Both timestamp 5 tie -> alpha order; both null tie -> alpha order; timestamped sort before null.
    expect(sortFiles(files, "last-updated").map((x) => x.name)).toEqual(["Beta", "Mid", "Alpha", "Zebra"])
  })

  it("does not mutate the input array", () => {
    const files = [f("B", 1), f("A", 2)]
    const original = [...files]
    sortFiles(files, "last-updated")
    expect(files).toEqual(original)
  })
})

describe("sortFiles — canonical (biblical order)", () => {
  it("orders Bible book files Genesis-before-Exodus regardless of input order", () => {
    const files = [f("EXO.usfm", null), f("GEN.usfm", null), f("LEV.usfm", null)]
    expect(sortFiles(files, "canonical").map((x) => x.name)).toEqual(["GEN.usfm", "EXO.usfm", "LEV.usfm"])
  })

  it("orders OT before NT", () => {
    const files = [f("MAT.usfm", null), f("PSA.usfm", null), f("REV.usfm", null)]
    expect(sortFiles(files, "canonical").map((x) => x.name)).toEqual(["PSA.usfm", "MAT.usfm", "REV.usfm"])
  })

  it("sorts files with no recognizable book code after all known books, alphabetically among themselves", () => {
    const files = [f("Notes.txt", null), f("GEN.usfm", null), f("Appendix.txt", null)]
    expect(sortFiles(files, "canonical").map((x) => x.name)).toEqual(["GEN.usfm", "Appendix.txt", "Notes.txt"])
  })

  it("resolves book names as well as USFM codes (matches getBookOrdinal's dual lookup)", () => {
    const files = [f("Exodus", null), f("Genesis", null)]
    expect(sortFiles(files, "canonical").map((x) => x.name)).toEqual(["Genesis", "Exodus"])
  })
})

describe("sortFiles — alphabetical", () => {
  it("orders by locale-aware name compare, ignoring canonical/last-updated signals", () => {
    const files = [f("Zephaniah", 999), f("Amos", 1), f("gen.usfm", null)]
    expect(sortFiles(files, "alphabetical").map((x) => x.name)).toEqual(["Amos", "gen.usfm", "Zephaniah"])
  })
})

describe("filterFilesByName", () => {
  const files = [f("GEN.usfm", null), f("EXO.usfm", null), f("Notes.txt", null)]

  it("returns all files for an empty or whitespace-only query", () => {
    expect(filterFilesByName(files, "").map((x) => x.name)).toHaveLength(3)
    expect(filterFilesByName(files, "   ").map((x) => x.name)).toHaveLength(3)
  })

  it("filters case-insensitively by substring match on name", () => {
    expect(filterFilesByName(files, "gen").map((x) => x.name)).toEqual(["GEN.usfm"])
    expect(filterFilesByName(files, "USFM").map((x) => x.name)).toEqual(["GEN.usfm", "EXO.usfm"])
  })

  it("returns an empty array when nothing matches", () => {
    expect(filterFilesByName(files, "zzz")).toEqual([])
  })

  it("does not mutate the input array", () => {
    const original = [...files]
    filterFilesByName(files, "gen")
    expect(files).toEqual(original)
  })
})
