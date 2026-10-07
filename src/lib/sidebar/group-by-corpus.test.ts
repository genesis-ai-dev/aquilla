import { describe, it, expect } from "vitest"
import { groupByCorpus, groupLabelForMarker } from "./group-by-corpus"

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

// Projects migrated from legacy Codex carry neither a corpusMarker nor a
// bookCode: the migrator stamps every non-IDML file `"codex"` and names it by
// bare book code. Without a third fallback all 66 books sat in "Ungrouped" and
// the Jump to Testament control never appeared (PR #504 review, 2026-09-07).
describe("groupByCorpus — file-name fallback for migrated projects (AQU-1084)", () => {
  const OT_CODES = [
    "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA", "1KI", "2KI", "1CH", "2CH",
    "EZR", "NEH", "EST", "JOB", "PSA", "PRO", "ECC", "SNG", "ISA", "JER", "LAM", "EZK", "DAN", "HOS",
    "JOL", "AMO", "OBA", "JON", "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL",
  ]
  const NT_CODES = [
    "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH", "PHP", "COL", "1TH", "2TH",
    "1TI", "2TI", "TIT", "PHM", "HEB", "JAS", "1PE", "2PE", "1JN", "2JN", "3JN", "JUD", "REV",
  ]
  // Shape of a migrated file as the client sees it: `type` is the server
  // `kind`, which the migrator sets to "codex" (outside the FileType union).
  function migrated(name: string) {
    return { id: name, name, type: "codex", createdAt: "", cellCount: 0 }
  }

  it("splits a migrated 66-book project into OT and NT from the file names alone", () => {
    const shuffled = [...NT_CODES, ...OT_CODES].sort()
    const groups = groupByCorpus(shuffled.map(migrated))
    expect(groups.map((g) => g.label)).toEqual(["OT", "NT"])
    expect(groups[0].files.map((x) => x.name)).toEqual(OT_CODES)
    expect(groups[1].files.map((x) => x.name)).toEqual(NT_CODES)
    expect(groups[0].derived).toBe(true)
    expect(groups[1].derived).toBe(true)
  })

  it("applies the name rule to native Scripture types too", () => {
    const groups = groupByCorpus([
      { ...f("40-MAT.usfm"), type: "usfm" },
      { ...f("gen"), type: "ebible" },
    ])
    expect(groups.map((g) => g.label)).toEqual(["OT", "NT"])
  })

  it("leaves a non-Scripture file alone even when its name is a book code", () => {
    const groups = groupByCorpus([f("ACT"), { ...f("JOB.md"), type: "md" }])
    expect(groups.map((g) => g.label)).toEqual(["Ungrouped"])
    expect(groups[0].files.map((x) => x.name)).toEqual(["ACT", "JOB.md"])
  })

  it("lets hasScriptureContent open the name rule for a custom-format file", () => {
    const groups = groupByCorpus([{ ...f("ACT"), type: "csv", hasScriptureContent: true }])
    expect(groups.map((g) => g.label)).toEqual(["NT"])
  })

  it("lets bookCode win over a misleading file name", () => {
    const groups = groupByCorpus([{ ...migrated("Estimates"), bookCode: "MAT" }])
    expect(groups.map((g) => g.label)).toEqual(["NT"])
  })

  it("keeps corpusMarker ahead of both fallbacks", () => {
    const groups = groupByCorpus([{ ...migrated("GEN"), corpusMarker: "Season 1" }])
    expect(groups.map((g) => g.label)).toEqual(["Season 1"])
    expect(groups[0].derived).toBeUndefined()
  })

  // AQU-1187: the eBible/Hello AO importers now emit one file per book, named by
  // book and carrying bookCode but no corpusMarker. That has to land in OT/NT in
  // canonical order — it is the whole reason the split exists.
  it("groups per-book scripture-catalog files into OT and NT in canonical order", () => {
    const perBook = (name: string, bookCode: string) => ({ name, bookCode, type: "ebible" })
    const groups = groupByCorpus([
      perBook("Matthew", "MAT"),
      perBook("Exodus", "EXO"),
      perBook("Genesis", "GEN"),
      perBook("Revelation", "REV"),
    ])

    expect(groups.map((g) => g.label)).toEqual(["OT", "NT"])
    expect(groups[0].files.map((x) => x.name)).toEqual(["Genesis", "Exodus"])
    expect(groups[1].files.map((x) => x.name)).toEqual(["Matthew", "Revelation"])
    // Derived from bookCode, not from a marker the user can rename.
    expect(groups[0].derived).toBe(true)
  })
})

// AQU-1569: a hand-placed order (files.meta.sortIndex, via `file.reorder`)
// overrides the name-derived rules. The regression these tests guard is NOT
// the new feature — it is that a project where nobody has reordered anything
// still sorts byte-for-byte as it did before the feature existed.
describe("groupByCorpus — hand-placed order (AQU-1569)", () => {
  const placed = (name: string, corpusMarker: string, sortIndex?: number) => ({
    ...f(name, corpusMarker),
    ...(sortIndex === undefined ? {} : { sortIndex }),
  })

  it("leaves a group nobody has reordered on today's rules", () => {
    const groups = groupByCorpus([
      placed("Episode 1", "Season 1"),
      placed("Episode 10", "Season 1"),
      placed("Episode 2", "Season 1"),
    ])
    // Plain localeCompare, numbers and all — unchanged, deliberately.
    expect(groups[0].files.map((x) => x.name)).toEqual(["Episode 1", "Episode 10", "Episode 2"])
  })

  it("sorts a fully placed group by its indices, not its names", () => {
    const groups = groupByCorpus([
      placed("Episode 10", "Season 1", 3072),
      placed("Episode 1", "Season 1", 0),
      placed("Episode 3", "Season 1", 2048),
      placed("Episode 2", "Season 1", 1024),
    ])
    expect(groups[0].files.map((x) => x.name))
      .toEqual(["Episode 1", "Episode 2", "Episode 3", "Episode 10"])
  })

  it("honours a fractional midpoint between two neighbours", () => {
    const groups = groupByCorpus([
      placed("first", "Season 1", 0),
      placed("last", "Season 1", 1024),
      placed("squeezed in", "Season 1", 512),
    ])
    expect(groups[0].files.map((x) => x.name)).toEqual(["first", "squeezed in", "last"])
  })

  it("puts placed files first, in placed order, and the rest in today's order after them", () => {
    const groups = groupByCorpus([
      placed("Alpha", "Season 1"),
      placed("Zulu", "Season 1", 1024),
      placed("Bravo", "Season 1"),
      placed("Yankee", "Season 1", 0),
    ])
    // The two placed files keep the order a person gave them; the two nobody
    // touched follow, alphabetically among themselves. This is what stops an
    // imported file from scrambling a hand-ordered group.
    expect(groups[0].files.map((x) => x.name)).toEqual(["Yankee", "Zulu", "Alpha", "Bravo"])
  })

  it("breaks a tie between equal indices with today's comparator", () => {
    // Two devices can mint the same midpoint; the order still has to be stable.
    const groups = groupByCorpus([
      placed("zeta", "Season 1", 512),
      placed("alpha", "Season 1", 512),
    ])
    expect(groups[0].files.map((x) => x.name)).toEqual(["alpha", "zeta"])
  })

  it("beats canonical book order inside OT/NT when a lead has placed the books", () => {
    const groups = groupByCorpus([
      { ...f("Matthew", "NT"), bookCode: "MAT", sortIndex: 1024 },
      { ...f("Mark", "NT"), bookCode: "MRK", sortIndex: 0 },
    ])
    expect(groups[0].files.map((x) => x.name)).toEqual(["Mark", "Matthew"])
  })

  it("keeps canonical book order in OT/NT when no book is placed", () => {
    const groups = groupByCorpus([
      { ...f("Matthew", "NT"), bookCode: "MAT" },
      { ...f("Mark", "NT"), bookCode: "MRK" },
    ])
    expect(groups[0].files.map((x) => x.name)).toEqual(["Matthew", "Mark"])
  })

  it("applies a placed order inside the synthetic Ungrouped bucket too", () => {
    const groups = groupByCorpus([
      { ...f("notes"), sortIndex: 1024 },
      { ...f("readme"), sortIndex: 0 },
    ])
    expect(groups[0].label).toBe("Ungrouped")
    expect(groups[0].files.map((x) => x.name)).toEqual(["readme", "notes"])
  })

  // The index arrives as raw JSON off the wire (files.meta), so a non-number,
  // a NaN or an Infinity has to read as "not placed" rather than poison the
  // sort with a comparison that is not transitive.
  it("ignores an unusable index and falls back to today's order", () => {
    const groups = groupByCorpus([
      { ...f("b", "Season 1"), sortIndex: Number.NaN },
      { ...f("a", "Season 1"), sortIndex: "7" as unknown as number },
      { ...f("c", "Season 1"), sortIndex: Number.POSITIVE_INFINITY },
    ])
    expect(groups[0].files.map((x) => x.name)).toEqual(["a", "b", "c"])
  })
})

// AQU-1702: a cross-group drag asks this before it writes, because a file's
// group is not always its marker — clearing a Bible book's marker hands it
// straight back to the testament fallback.
describe("groupLabelForMarker", () => {
  /** A Bible book in a scripture-capable file, so the fallback can read it. */
  const book = (name: string, corpusMarker?: string) =>
    ({ ...f(name, corpusMarker), type: "usfm" })

  it("is the marker when there is one", () => {
    expect(groupLabelForMarker(book("GEN", "Season 1"), "Season 2")).toBe("Season 2")
  })

  it("falls back to the testament when the marker is cleared", () => {
    expect(groupLabelForMarker(book("GEN"), null)).toBe("OT")
    expect(groupLabelForMarker(book("ACT"), "")).toBe("NT")
  })

  it("is Ungrouped for a file with no book to fall back to", () => {
    expect(groupLabelForMarker(f("notes"), null)).toBe("Ungrouped")
  })

  it("agrees with the group a marker actually produces", () => {
    const file = book("GEN", "Season 1")
    const marker = groupLabelForMarker(file, "OT")
    expect(groupByCorpus([{ ...file, corpusMarker: marker }])[0].label).toBe(marker)
  })
})
