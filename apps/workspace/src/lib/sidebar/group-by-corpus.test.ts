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
    expect(groups).toEqual([{ label: "Ungrouped", files: [f("a"), f("b")] }])
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
})
