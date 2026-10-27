// AQU-2190: "Name a section inside a chapter" — the derivation.
//
// AQU-2185 gives a marked cell a new TOP-LEVEL division, but only where the APP
// invented the divisions; inside a Scripture chapter or a document heading
// section it dropped the label, because a file's own structure must never be
// moved or removed. This slice stops dropping it: the marker becomes a named
// sub-entry nested under its parent division. What is pinned below:
//
//   * the top-level list does NOT change — that is the whole guarantee, and it
//     is what keeps everything keyed by chapter (export scope, the sidebar
//     list, assignment) behaving exactly as before;
//   * a sub-section runs from its cell to the next sub-section or the END of
//     its parent division, never past it into the next chapter or heading;
//   * the cells above the first marker stay with the division itself, so a
//     long IDML story's automatic ranges before a marker remain and the ones
//     after it are replaced.

import { describe, expect, it } from "vitest"
import {
  deriveMilestoneNavigation,
  handSetSubsectionKey,
  handSetSubsectionSpans,
  listedSubsectionsFor,
  type MilestoneNavigationCell,
} from "./milestone-navigation"
import type { ImportMilestone } from "../../shared/import-contract"

function persisted(
  id: string,
  milestone: ImportMilestone,
  overrides: Partial<MilestoneNavigationCell> = {},
): MilestoneNavigationCell {
  return { id, original: id, metadata: { aquillaImport: { milestone } }, ...overrides }
}

const chapter = (book: string, n: number): ImportMilestone => ({
  key: `scripture:${book}:${n}`, kind: "chapter", label: `${book} ${n}`, shortLabel: String(n),
})

const heading = (n: number): ImportMilestone => ({
  key: `section:${n}`, kind: "section", label: `Heading ${n}`, shortLabel: "S",
})

/** The navigator's top-level entries as (label, first cell, cell count) triples. */
function entries(cells: readonly MilestoneNavigationCell[]) {
  return deriveMilestoneNavigation(cells).orderedMilestones.map((group) => ({
    label: group.milestone.label,
    kind: group.milestone.kind,
    firstCellId: group.firstCellId,
    count: group.cellIds.length,
  }))
}

/**
 * The sub-entries each division would list, the way the store builds them: the
 * derivation reports the markers, and the spans are cut per division. Stated
 * here as one helper so every case below asserts the composition rather than
 * the two halves separately (AGENTS.md's producer/consumer rule).
 */
function subEntries(cells: readonly MilestoneNavigationCell[]) {
  const derived = deriveMilestoneNavigation(cells)
  return derived.orderedMilestones.map((group) => {
    const { leading, spans } = handSetSubsectionSpans(
      group.cellIds,
      derived.handSetSubsectionLabels,
    )
    return {
      division: group.milestone.label,
      leading,
      spans: spans.map((span) => ({
        label: span.label,
        cellId: span.cellId,
        cellIds: span.cellIds,
      })),
    }
  })
}

/** Mark 4:1–4:5 and its neighbours, the file the ticket names. */
function markFile(marks: Record<string, string> = {}): MilestoneNavigationCell[] {
  const verse = (book: string, ch: number, v: number) => {
    const id = `${book}${ch}-${v}`
    return persisted(id, chapter(book, ch), marks[id] === undefined ? {} : { milestoneLabel: marks[id] })
  }
  return [
    verse("MRK", 3, 1),
    verse("MRK", 4, 1), verse("MRK", 4, 2), verse("MRK", 4, 3),
    verse("MRK", 4, 4), verse("MRK", 4, 5),
    verse("MRK", 5, 1),
  ]
}

describe("deriveMilestoneNavigation — sub-entries inside a file's own divisions (AQU-2190)", () => {
  it("leaves the top-level list exactly as it was and nests the marker under its chapter", () => {
    const marked = markFile({ "MRK4-4": "The calming of the storm" })

    // Mark 4 is still ONE entry holding all five of its verses, and Mark 3 and
    // Mark 5 are untouched — compared against the unmarked file itself rather
    // than a hand-written list, so this cannot drift.
    expect(entries(marked)).toEqual(entries(markFile()))

    expect(subEntries(marked)).toEqual([
      { division: "MRK 3", leading: ["MRK3-1"], spans: [] },
      {
        division: "MRK 4",
        // The verses above the marker stay with the chapter itself.
        leading: ["MRK4-1", "MRK4-2", "MRK4-3"],
        spans: [{
          label: "The calming of the storm",
          cellId: "MRK4-4",
          cellIds: ["MRK4-4", "MRK4-5"],
        }],
      },
      { division: "MRK 5", leading: ["MRK5-1"], spans: [] },
    ])
  })

  it("splits the chapter at a second marker, and the first sub-section ends above it", () => {
    const marked = markFile({ "MRK4-1": "Parables", "MRK4-4": "The calming of the storm" })

    expect(entries(marked)).toEqual(entries(markFile()))
    expect(subEntries(marked)[1]).toEqual({
      division: "MRK 4",
      // Nothing is left over: the first marker is the chapter's own first verse.
      leading: [],
      spans: [
        { label: "Parables", cellId: "MRK4-1", cellIds: ["MRK4-1", "MRK4-2", "MRK4-3"] },
        {
          label: "The calming of the storm",
          cellId: "MRK4-4",
          cellIds: ["MRK4-4", "MRK4-5"],
        },
      ],
    })
  })

  it("never lets a sub-section reach into the next chapter, even unmarked to its end", () => {
    // The marker is on Mark 4's LAST verse, so a run that could straddle would
    // swallow Mark 5:1 — the next division supplies the stop.
    const spans = subEntries(markFile({ "MRK4-5": "Crossing over" }))

    expect(spans[1].spans).toEqual([
      { label: "Crossing over", cellId: "MRK4-5", cellIds: ["MRK4-5"] },
    ])
    expect(spans[2]).toEqual({ division: "MRK 5", leading: ["MRK5-1"], spans: [] })
  })

  it("nests under the right heading in a document, and stops at the next heading", () => {
    const cells = [
      persisted("h1", heading(1)),
      persisted("h1-a", heading(1)),
      persisted("h1-b", heading(1), { milestoneLabel: "The scene at the well" }),
      persisted("h2", heading(2)),
      persisted("h2-a", heading(2)),
    ]

    expect(subEntries(cells)).toEqual([
      {
        division: "Heading 1",
        leading: ["h1", "h1-a"],
        spans: [{
          label: "The scene at the well",
          cellId: "h1-b",
          cellIds: ["h1-b"],
        }],
      },
      { division: "Heading 2", leading: ["h2", "h2-a"], spans: [] },
    ])
  })

  it("keeps a whole division as `leading` when nothing in it is marked", () => {
    // The answer every file that has never had a section set gets, and the one
    // that keeps the automatic cell ranges exactly as they were.
    expect(subEntries(markFile())).toEqual([
      { division: "MRK 3", leading: ["MRK3-1"], spans: [] },
      {
        division: "MRK 4",
        leading: ["MRK4-1", "MRK4-2", "MRK4-3", "MRK4-4", "MRK4-5"],
        spans: [],
      },
      { division: "MRK 5", leading: ["MRK5-1"], spans: [] },
    ])
  })

  it("ignores a blank or whitespace-only label, the way a top-level marker does", () => {
    const derived = deriveMilestoneNavigation(markFile({ "MRK4-4": "   " }))
    expect([...derived.handSetSubsectionLabels]).toEqual([])
  })

  it("reports a marker in an app-invented division as a top-level section, not a sub-entry", () => {
    // The AQU-2185 case, asserted from this side too: the two shapes a marker
    // can take are exclusive, so a division cannot be both replaced and nested.
    const cells: MilestoneNavigationCell[] = Array.from({ length: 3 }, (_, index) => (
      index === 1
        ? { id: `c${index}`, original: "line", milestoneLabel: "The storm" }
        : { id: `c${index}`, original: "line" }
    ))
    const derived = deriveMilestoneNavigation(cells)

    expect([...derived.handSetSubsectionLabels]).toEqual([])
    expect(derived.orderedMilestones.map((group) => group.milestone.kind)).toContain("hand-set")
  })
})

describe("handSetSubsectionSpans (AQU-2190)", () => {
  it("returns the whole list as `leading` with no markers", () => {
    expect(handSetSubsectionSpans(["a", "b", "c"], new Map())).toEqual({
      leading: ["a", "b", "c"],
      spans: [],
    })
  })

  it("only honours markers on cells the division actually holds", () => {
    // A label on a cell of ANOTHER division is a no-op here, which is the
    // mechanism behind "a sub-section never crosses a chapter boundary": the
    // caller hands over one division's cells, so there is nothing to cross.
    expect(handSetSubsectionSpans(["a", "b"], new Map([["z", "Elsewhere"]]))).toEqual({
      leading: ["a", "b"],
      spans: [],
    })
  })
})

describe("handSetSubsectionKey (AQU-2190)", () => {
  it("scopes the key to the division, and keeps it apart from an automatic range's", () => {
    expect(handSetSubsectionKey("scripture:MRK:4", "MRK4-4"))
      .not.toEqual(handSetSubsectionKey("scripture:MRK:5", "MRK4-4"))
    expect(handSetSubsectionKey("scripture:MRK:4", "MRK4-4"))
      .not.toEqual("scripture:MRK:4:range:MRK4-4")
  })
})

describe("listedSubsectionsFor (AQU-2190)", () => {
  const range = { key: "r", handSetCellId: undefined }
  const named = { key: "n", handSetCellId: "c35" }

  it("lists nothing for an ordinary division with only automatic ranges", () => {
    // What keeps an unmarked 41-verse chapter a row you can pick rather than
    // one that only expands.
    expect(listedSubsectionsFor([range], false)).toEqual([])
  })

  it("lists every part of a division once a section is named inside it", () => {
    // ALL of them, the range above the marker included: a listed division's
    // sub-entries must cover it, or the cells above the marker sit in no row.
    expect(listedSubsectionsFor([range, named], false)).toEqual([range, named])
  })

  it("lists them for a long story whether or not anything is named", () => {
    expect(listedSubsectionsFor([range], true)).toEqual([range])
  })
})
