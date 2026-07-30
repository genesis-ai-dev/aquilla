import { describe, expect, it } from "vitest"
import {
  deriveMilestoneNavigation,
  readImportMilestone,
  type MilestoneNavigationCell,
} from "./milestone-navigation"
import type { ImportMilestone } from "../../shared/import-contract"

function persisted(
  id: string,
  milestone: ImportMilestone,
  overrides: Partial<MilestoneNavigationCell> = {},
): MilestoneNavigationCell {
  return {
    id,
    original: id,
    metadata: { aquillaImport: { milestone } },
    ...overrides,
  }
}

describe("deriveMilestoneNavigation", () => {
  it("preserves stable keys when two headings have the same visible label", () => {
    const result = deriveMilestoneNavigation([
      persisted("one", { key: "section:one", kind: "section", label: "Overview", shortLabel: "1" }),
      persisted("two", { key: "section:two", kind: "section", label: "Overview", shortLabel: "2" }),
    ])

    expect(result.orderedMilestones.map(({ milestone }) => milestone)).toEqual([
      { key: "section:one", kind: "section", label: "Overview", shortLabel: "1" },
      { key: "section:two", kind: "section", label: "Overview", shortLabel: "2" },
    ])
  })

  it("returns milestones in the supplied display order", () => {
    const chapterOne = { key: "scripture:GEN:1", kind: "chapter", label: "Genesis 1", shortLabel: "1" } as const
    const chapterTwo = { key: "scripture:GEN:2", kind: "chapter", label: "Genesis 2", shortLabel: "2" } as const
    const result = deriveMilestoneNavigation([
      persisted("chapter-two", chapterTwo),
      persisted("chapter-one", chapterOne),
    ])

    expect(result.orderedMilestones.map(({ milestone }) => milestone.key)).toEqual([
      "scripture:GEN:2",
      "scripture:GEN:1",
    ])
    expect(result.orderedMilestones.map(({ firstIndex }) => firstIndex)).toEqual([0, 1])
  })

  it("attaches legacy Scripture headings to the following chapter", () => {
    const result = deriveMilestoneNavigation([
      { id: "verse-one", original: "In the beginning", canonicalRef: "GEN 1:1" },
      { id: "heading-two", original: "Genesis 2", type: "heading" },
      { id: "verse-two", original: "Thus the heavens", canonicalRef: "GEN 2:1" },
    ])

    expect(result.milestoneByCellId.get("verse-one")?.key).toBe("scripture:GEN:1")
    expect(result.milestoneByCellId.get("heading-two")?.key).toBe("scripture:GEN:2")
    expect(result.milestoneByCellId.get("verse-two")?.key).toBe("scripture:GEN:2")
  })

  it("derives legacy Biblica preface and chapter-range milestones", () => {
    const result = deriveMilestoneNavigation([
      { id: "preface", original: "Introduction", metadata: { biblica: { bookCode: "GEN", chapterLabel: "Preface" } } },
      { id: "range", original: "A study note", metadata: { biblica: { bookCode: "GEN", chapterLabel: "1-2" } } },
    ])

    expect(result.orderedMilestones.map(({ milestone }) => milestone)).toEqual([
      { key: "biblica:GEN:Preface", kind: "preface", label: "Genesis Preface", shortLabel: "P" },
      { key: "biblica:GEN:1-2", kind: "chapter-range", label: "Genesis 1–2", shortLabel: "1–2" },
    ])
  })

  it("uses Start before the first section and lets later user-added cells inherit it", () => {
    const milestone = { key: "section:intro", kind: "section", label: "Introduction", shortLabel: "1" } as const
    const result = deriveMilestoneNavigation([
      { id: "inserted-before", original: "New first cell" },
      persisted("imported", milestone),
      { id: "inserted-after", original: "New last cell" },
    ])

    expect([...result.milestoneByCellId.values()]).toEqual([
      { key: "section:start", kind: "section", label: "Start", shortLabel: "S" },
      milestone,
      milestone,
    ])
  })

  it("falls back to deterministic 50-cell parts for legacy flat files", () => {
    const result = deriveMilestoneNavigation(Array.from({ length: 51 }, (_, index) => ({
      id: `cell-${index + 1}`,
      original: `Cell ${index + 1}`,
    })))

    expect(result.orderedMilestones.map(({ milestone, cellIds }) => ({
      key: milestone.key,
      label: milestone.label,
      count: cellIds.length,
    }))).toEqual([
      { key: "part:cell-1", label: "Part 1", count: 50 },
      { key: "part:cell-51", label: "Part 2", count: 1 },
    ])
  })
})

describe("readImportMilestone", () => {
  it("rejects incomplete or unknown metadata while accepting the additive contract", () => {
    expect(readImportMilestone({
      aquillaImport: {
        milestone: { key: "part:first", kind: "part", label: "Part 1", shortLabel: "1" },
      },
    })).toEqual({ key: "part:first", kind: "part", label: "Part 1", shortLabel: "1" })
    expect(readImportMilestone({
      aquillaImport: {
        milestone: { key: "part:first", kind: "unknown", label: "Part 1", shortLabel: "1" },
      },
    })).toBeUndefined()
  })
})
