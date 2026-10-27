// AQU-2185: "Start a section here" — the derivation.
//
// This is where the feature actually lives. The navigator entries, their
// progress figures, previous/next stepping and the Split-into-milestones pages
// are all built from `deriveMilestoneNavigation`'s `orderedMilestones`, so a
// division that comes out correct here comes out correct on every one of those
// surfaces. What is pinned below is the precedence AQU-318's design decision
// settled on 2026-10-26:
//
//   * a marked cell starts a new TOP-LEVEL division;
//   * it runs to the next marker, or to the next division the FILE supplied;
//   * app-made divisions BEFORE the first marker are untouched;
//   * a division the file supplied is never moved or removed, and a label on
//     such a cell is ignored (sub-entries are AQU-2190's slice);
//   * the AI-section overlay never re-cuts a hand-set section.

import { describe, expect, it } from "vitest"
import {
  deriveMilestoneNavigation,
  milestoneAcceptsHandSetSection,
  type MilestoneNavigationCell,
} from "./milestone-navigation"
import { FALLBACK_MILESTONE_SIZE } from "./import/milestones"
import type { ImportMilestone } from "../../shared/import-contract"

/** A plain line with nothing the app can divide on — the "Part N" case. */
function plain(index: number, overrides: Partial<MilestoneNavigationCell> = {}): MilestoneNavigationCell {
  return { id: `c${index}`, original: `line ${index}`, ...overrides }
}

/** `count` plain lines, with a hand-set label on the cells named in `marks`. */
function plainFile(count: number, marks: Record<number, string> = {}): MilestoneNavigationCell[] {
  return Array.from({ length: count }, (_, index) => (
    marks[index] === undefined ? plain(index) : plain(index, { milestoneLabel: marks[index] })
  ))
}

function persisted(
  id: string,
  milestone: ImportMilestone,
  overrides: Partial<MilestoneNavigationCell> = {},
): MilestoneNavigationCell {
  return { id, original: id, metadata: { aquillaImport: { milestone } }, ...overrides }
}

/** The navigator's entries as (label, first cell, cell count) triples. */
function entries(cells: readonly MilestoneNavigationCell[], options?: Parameters<typeof deriveMilestoneNavigation>[1]) {
  return deriveMilestoneNavigation(cells, options).orderedMilestones.map((group) => ({
    label: group.milestone.label,
    kind: group.milestone.kind,
    firstCellId: group.firstCellId,
    count: group.cellIds.length,
  }))
}

describe("deriveMilestoneNavigation — hand-set sections (AQU-2185)", () => {
  // 120 plain lines ⇒ Part 1 (c0–c49), Part 2 (c50–c99), Part 3 (c100–c119),
  // which is the file the ticket's "where to test" names.
  const SIZE = FALLBACK_MILESTONE_SIZE

  it("starts a new division at the marked cell and runs it to the end of the file", () => {
    const result = entries(plainFile(120, { 70: "The storm" }))

    expect(result).toEqual([
      // Untouched: it is before the marker.
      { label: "Part 1", kind: "part", firstCellId: "c0", count: SIZE },
      // Ends just above the marked cell rather than at c99.
      { label: "Part 2", kind: "part", firstCellId: "c50", count: 20 },
      // And "Part 3" is gone, because the hand-set section swallowed its cells.
      { label: "The storm", kind: "hand-set", firstCellId: "c70", count: 50 },
    ])
  })

  it("splits a hand-set section at a second marker, in file order", () => {
    const result = entries(plainFile(120, { 70: "The storm", 100: "The calm" }))

    expect(result).toEqual([
      { label: "Part 1", kind: "part", firstCellId: "c0", count: SIZE },
      { label: "Part 2", kind: "part", firstCellId: "c50", count: 20 },
      { label: "The storm", kind: "hand-set", firstCellId: "c70", count: 30 },
      { label: "The calm", kind: "hand-set", firstCellId: "c100", count: 20 },
    ])
  })

  it("keys a section by its marked cell, so two sections may share a name", () => {
    const derived = deriveMilestoneNavigation(plainFile(120, { 60: "Part two", 90: "Part two" }))
    const handSet = derived.orderedMilestones.filter(({ milestone }) => milestone.kind === "hand-set")

    expect(handSet.map(({ milestone }) => milestone.key)).toEqual(["handset:c60", "handset:c90"])
    // Both are listed: a shared name must not collapse them into one division.
    expect(handSet).toHaveLength(2)
  })

  it("shows the name exactly as given, without translating or truncating it", () => {
    const label = "Yeshu‘a goes up to Yerushalayim — the last week"
    const derived = deriveMilestoneNavigation(plainFile(60, { 10: label }))
    const handSet = derived.orderedMilestones.find(({ milestone }) => milestone.kind === "hand-set")

    expect(handSet?.milestone.label).toBe(label)
    expect(handSet?.milestone.shortLabel).toBe("§")
  })

  it("ignores a blank label, leaving the app-made divisions as they were", () => {
    expect(entries(plainFile(120, { 70: "   " }))).toEqual(
      entries(plainFile(120)),
    )
  })

  it("marks every cell of the section, not only the one that was marked", () => {
    const derived = deriveMilestoneNavigation(plainFile(120, { 70: "The storm" }))

    expect(derived.milestoneByCellId.get("c70")?.key).toBe("handset:c70")
    expect(derived.milestoneByCellId.get("c90")?.key).toBe("handset:c70")
    expect(derived.milestoneByCellId.get("c119")?.key).toBe("handset:c70")
    // And nothing before it.
    expect(derived.milestoneByCellId.get("c69")?.kind).toBe("part")
  })

  it("ends a section at the next division the file supplied, and leaves that division alone", () => {
    // A timed transcript that also carries a heading of its own: the 5-minute
    // buckets around it are the app's to replace, the heading is not. (A
    // "Part N" run cannot be used for this case — every cell of a file that has
    // identity somewhere inherits that identity, so `part` only ever appears in
    // a file that is generic all the way through.)
    const heading: ImportMilestone = {
      key: "section:intro", kind: "section", label: "Introduction", shortLabel: "§",
    }
    const cells: MilestoneNavigationCell[] = [
      { id: "q0", original: "cue 0", startMs: 0 },
      { id: "q1", original: "cue 1", startMs: 60_000 },
      { id: "q2", original: "cue 2", startMs: 120_000, milestoneLabel: "The storm" },
      persisted("h", heading, { type: "heading" }),
      { id: "q4", original: "cue 4", startMs: 360_000 },
    ]

    expect(entries(cells)).toEqual([
      // The app-made bucket before the marker, unchanged.
      { label: "00:00–05:00", kind: "time-range", firstCellId: "q0", count: 2 },
      // The section runs from the marker up to — not through — the heading.
      { label: "The storm", kind: "hand-set", firstCellId: "q2", count: 1 },
      // The file's own heading, unmoved.
      { label: "Introduction", kind: "section", firstCellId: "h", count: 1 },
      // And the bucket after it is app-made again, with no section running.
      { label: "05:00–10:00", kind: "time-range", firstCellId: "q4", count: 1 },
    ])
  })

  it("leaves a Scripture file's chapters untouched, even if a label reaches one of its cells", () => {
    const chapter = (n: number): ImportMilestone => ({
      key: `scripture:GEN:${n}`, kind: "chapter", label: `Genesis ${n}`, shortLabel: String(n),
    })
    const cells = [
      persisted("gen1-1", chapter(1)),
      // A label here is IGNORED: inside a division the file supplied, a marker
      // becomes a sub-entry, which is AQU-2190's slice and not this one's.
      persisted("gen1-2", chapter(1), { milestoneLabel: "The flood" }),
      persisted("gen2-1", chapter(2)),
    ]

    expect(entries(cells)).toEqual([
      { label: "Genesis 1", kind: "chapter", firstCellId: "gen1-1", count: 2 },
      { label: "Genesis 2", kind: "chapter", firstCellId: "gen2-1", count: 1 },
    ])
  })

  it("replaces a 5-minute bucket on a timed file and leaves the earlier buckets alone", () => {
    const cue = (index: number, startMs: number, overrides: Partial<MilestoneNavigationCell> = {}) => ({
      id: `q${index}`, original: `cue ${index}`, startMs, ...overrides,
    })
    const cells: MilestoneNavigationCell[] = [
      cue(0, 0),
      cue(1, 60_000),
      // Second 5-minute range.
      cue(2, 5 * 60_000, { milestoneLabel: "The storm" }),
      cue(3, 7 * 60_000),
      // Third range — swallowed, because the section runs on.
      cue(4, 11 * 60_000),
    ]

    expect(entries(cells)).toEqual([
      { label: "00:00–05:00", kind: "time-range", firstCellId: "q0", count: 2 },
      { label: "The storm", kind: "hand-set", firstCellId: "q2", count: 3 },
    ])
  })

  it("keeps a hand-set section exactly as set when the AI overlay is on, and re-cuts only the stretch before it", () => {
    // Every seam scores high, so the overlay would cut aggressively if allowed.
    const cells = plainFile(12, { 6: "The storm" })
    const result = entries(cells, { boundaries: () => ({ level: 4 as const }), aiSections: true })

    const handSet = result.filter((entry) => entry.kind === "hand-set")
    expect(handSet).toEqual([
      { label: "The storm", kind: "hand-set", firstCellId: "c6", count: 6 },
    ])
    // The stretch before the marker IS re-cut — that is the overlay doing its
    // job on the cells that are still the app's to divide.
    expect(result.filter((entry) => entry.kind === "ai-section").length).toBeGreaterThan(0)
    // And no AI section may start inside the hand-set run.
    const derived = deriveMilestoneNavigation(cells, { boundaries: () => ({ level: 4 as const }), aiSections: true })
    for (const id of ["c6", "c7", "c8", "c9", "c10", "c11"]) {
      expect(derived.milestoneByCellId.get(id)?.key).toBe("handset:c6")
    }
  })

  it("protects a hand-set section whose cell carries a persisted generic `part` seed", () => {
    // The one door `handSetCovered` closes: `inheritedPart` would otherwise
    // still offer this cell to the overlay.
    const part: ImportMilestone = {
      key: "part:c0", kind: "part", label: "Part 1", shortLabel: "1",
    }
    const cells = [
      persisted("c0", part),
      persisted("c1", part, { milestoneLabel: "The storm" }),
      persisted("c2", part),
    ]
    const derived = deriveMilestoneNavigation(cells, { boundaries: () => ({ level: 4 as const }), aiSections: true })

    expect(derived.milestoneByCellId.get("c1")?.key).toBe("handset:c1")
    expect(derived.milestoneByCellId.get("c2")?.key).toBe("handset:c1")
  })

  it("changes nothing on a file nobody has marked", () => {
    expect(entries(plainFile(120))).toEqual([
      { label: "Part 1", kind: "part", firstCellId: "c0", count: SIZE },
      { label: "Part 2", kind: "part", firstCellId: "c50", count: SIZE },
      { label: "Part 3", kind: "part", firstCellId: "c100", count: 20 },
    ])
  })
})

describe("milestoneAcceptsHandSetSection (AQU-2185)", () => {
  it("accepts the divisions the app made up, and a hand-set one so a second marker splits it", () => {
    expect(milestoneAcceptsHandSetSection("part")).toBe(true)
    expect(milestoneAcceptsHandSetSection("time-range")).toBe(true)
    expect(milestoneAcceptsHandSetSection("ai-section")).toBe(true)
    expect(milestoneAcceptsHandSetSection("hand-set")).toBe(true)
  })

  it("refuses every division read out of the file — those take sub-entries (AQU-2190), not markers", () => {
    for (const kind of ["chapter", "chapter-range", "preface", "story", "slide", "section", "group"] as const) {
      expect(milestoneAcceptsHandSetSection(kind)).toBe(false)
    }
    // And an unknown/absent kind reads as "not here", which is the safe way round.
    expect(milestoneAcceptsHandSetSection(undefined)).toBe(false)
  })
})
