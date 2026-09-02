import { describe, it, expect } from "vitest"
import { groupByCorpus } from "./group-by-corpus"

function f(name: string, corpusMarker?: string) {
  return { id: name, name, type: "txt" as const, createdAt: "", cellCount: 0, corpusMarker }
}

describe("groupByCorpus", () => {
  it("returns empty array for empty input", () => {
    expect(groupByCorpus([])).toEqual([])
  })

  it("places files with no corpusMarker into 'Ungrouped'", () => {
    const groups = groupByCorpus([f("a"), f("b")])
    expect(groups).toEqual([
      { label: "Ungrouped", labelKey: "nav.fileList.ungroupedLabel", files: [f("a"), f("b")] },
    ])
  })

  it("groups files by corpusMarker and orders OT, NT, alpha, Ungrouped last", () => {
    const groups = groupByCorpus([
      f("zeta", "Subtitle"),
      f("a", "NT"),
      f("b", "OT"),
      f("c", "Aardvark"),
      f("d"),
    ])
    expect(groups.map((g) => g.label)).toEqual(["OT", "NT", "Aardvark", "Subtitle", "Ungrouped"])
  })

  it("normalizes case and whitespace so 'Subtitle' and ' subtitle ' merge", () => {
    const groups = groupByCorpus([f("a", "Subtitle"), f("b", " subtitle ")])
    expect(groups).toHaveLength(1)
    expect(groups[0].files).toHaveLength(2)
    // Display label uses the first-seen casing
    expect(groups[0].label).toBe("Subtitle")
  })

  it("sorts files within a non-Bible group alphabetically", () => {
    const groups = groupByCorpus([f("zeta", "Other"), f("alpha", "Other")])
    expect(groups[0].files.map((x) => x.name)).toEqual(["alpha", "zeta"])
  })

  it("sorts Bible books in canonical OT/NT order within OT and NT corpora", () => {
    const groups = groupByCorpus([
      f("Numbers", "OT"),
      f("Genesis", "OT"),
      f("Leviticus", "OT"),
      f("Revelation", "NT"),
      f("Matthew", "NT"),
      f("John", "NT"),
    ])
    expect(groups.find((g) => g.label === "OT")?.files.map((x) => x.name))
      .toEqual(["Genesis", "Leviticus", "Numbers"])
    expect(groups.find((g) => g.label === "NT")?.files.map((x) => x.name))
      .toEqual(["Matthew", "John", "Revelation"])
  })

  it("falls back to alphabetic when names aren't canonical book names", () => {
    const groups = groupByCorpus([f("ZZZ Misc", "OT"), f("AAA Misc", "OT")])
    expect(groups[0].files.map((x) => x.name)).toEqual(["AAA Misc", "ZZZ Misc"])
  })

  // AQU-582: existing Codex projects carry no corpusMarker, so every file lands
  // in the marker-less bucket. That bucket must still read like a Bible
  // (canonical order) instead of A–Z, which was the reported sidebar bug.
  it("sorts marker-less (Ungrouped) Bible books in canonical order", () => {
    const groups = groupByCorpus([
      f("Numbers"),
      f("Genesis"),
      f("Matthew"),
      f("Leviticus"),
      f("Revelation"),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe("Ungrouped")
    expect(groups[0].files.map((x) => x.name))
      .toEqual(["Genesis", "Leviticus", "Numbers", "Matthew", "Revelation"])
  })

  it("keeps non-book marker-less files alphabetic, after any known books", () => {
    const groups = groupByCorpus([f("zeta"), f("John"), f("alpha")])
    expect(groups[0].files.map((x) => x.name)).toEqual(["John", "alpha", "zeta"])
  })
})

// AQU-1084: corpusMarker is client-local and often missing after reload, so on
// a fresh device every Bible book used to land in "Ungrouped". The server-backed
// bookCode still says which testament a file belongs to; fall back to it.
describe("groupByCorpus — bookCode fallback (AQU-1084)", () => {
  function b(name: string, bookCode?: string, corpusMarker?: string) {
    return { ...f(name, corpusMarker), bookCode }
  }

  it("derives OT/NT groups from bookCode when corpusMarker is missing", () => {
    const groups = groupByCorpus([
      b("Revelation", "REV"),
      b("Genesis", "GEN"),
      b("Matthew", "MAT"),
      b("Exodus", "EXO"),
    ])
    expect(groups.map((g) => g.label)).toEqual(["OT", "NT"])
    expect(groups[0].files.map((x) => x.name)).toEqual(["Genesis", "Exodus"])
    expect(groups[1].files.map((x) => x.name)).toEqual(["Matthew", "Revelation"])
  })

  it("flags a derived group so callers can hide rename (renameCorpus matches on corpusMarker)", () => {
    const groups = groupByCorpus([b("Genesis", "GEN"), b("Exodus", "EXO", "OT")])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe("OT")
    expect(groups[0].derived).toBe(true)
    // Marker-authored groups carry no flag at all (keeps toEqual shapes stable).
    expect(groupByCorpus([b("Exodus", "EXO", "OT")])[0].derived).toBeUndefined()
  })

  it("lets corpusMarker win over bookCode so custom groups are untouched", () => {
    const groups = groupByCorpus([b("Genesis", "GEN", "Season 1"), b("Matthew", "MAT", "Season 1")])
    expect(groups.map((g) => g.label)).toEqual(["Season 1"])
    expect(groups[0].derived).toBeUndefined()
    expect(groups[0].files.map((x) => x.name)).toEqual(["Genesis", "Matthew"])
  })

  it("merges derived books into an existing marker-authored testament group", () => {
    const groups = groupByCorpus([b("Matthew", "MAT", "NT"), b("John", "JHN"), b("Mark", "MRK")])
    expect(groups.map((g) => g.label)).toEqual(["NT"])
    expect(groups[0].files.map((x) => x.name)).toEqual(["Matthew", "Mark", "John"])
  })

  it("keeps files with an unknown or missing bookCode in Ungrouped", () => {
    const groups = groupByCorpus([b("notes", "XYZ"), b("readme"), b("Genesis", "GEN")])
    expect(groups.map((g) => g.label)).toEqual(["OT", "Ungrouped"])
    expect(groups[1].files.map((x) => x.name)).toEqual(["notes", "readme"])
  })
})
