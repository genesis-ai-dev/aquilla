// AQU-2190 — sub-entries in the store: the nested rows a chapter lists, their
// figures, and the menu answers that drive them.
//
// The derivation (milestone-navigation.subEntries.test.ts) decides WHERE a
// marker inside a file-supplied division belongs. This file covers what the
// store builds on top of that, which is where the acceptance criteria actually
// land:
//
//   * the division stays one entry holding every cell it held, and its OWN
//     figures do not move — a named pericope re-groups cells that were already
//     counted, it does not add or remove any;
//   * each sub-entry carries the figures of its own cells;
//   * the marked cell is offered Rename/Remove, exactly as the cell that starts
//     a top-level section is (AQU-2186), because it is the same gesture.

import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "./useActiveCellStore"

function row(
  cellId: string,
  side: "source" | "target",
  value: string,
  opts: {
    milestoneLabel?: string
    canonicalRef?: string | null
    validated?: boolean
    milestone?: { key: string; kind: string; label: string; shortLabel: string }
  } = {},
): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef: opts.canonicalRef ?? null,
    anchorCellId: null,
    eventId: `${side}-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: opts.validated ?? false,
    wordCount: value ? 1 : 0,
    endorsementCount: 0,
    metadata: opts.milestone ? { aquillaImport: { milestone: opts.milestone } } : null,
    ...(opts.milestoneLabel ? { milestoneLabel: opts.milestoneLabel } : {}),
  }
}

/**
 * Mark 4 with five verses, plus one verse of Mark 3 and one of Mark 5 so the
 * neighbours can be asserted untouched. `marks` names the verses a section is
 * set on, `translated` the ones that have target text.
 */
function markFile(
  marks: Record<number, string> = {},
  translated: readonly number[] = [],
): CellRow[] {
  const rows: CellRow[] = [row("mrk3-1", "source", "mark 3:1", { canonicalRef: "MRK 3:1" })]
  for (let verse = 1; verse <= 5; verse++) {
    rows.push(row(`mrk4-${verse}`, "source", `mark 4:${verse}`, {
      canonicalRef: `MRK 4:${verse}`,
      milestoneLabel: marks[verse],
    }))
    rows.push(row(`mrk4-${verse}`, "target", translated.includes(verse) ? "translated" : ""))
  }
  rows.push(row("mrk5-1", "source", "mark 5:1", { canonicalRef: "MRK 5:1" }))
  return rows
}

function store(): CellStore {
  const s = new CellStore()
  s.setRuntime({
    projectId: "p",
    fileId: "f",
    username: "alice",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  return s
}

/** A division's nested rows as (label, first cell, cell count, is-it-named) tuples. */
function subEntriesOf(s: CellStore, milestoneKey: string) {
  const entry = s.getNavigationIndex().find((candidate) => candidate.key === milestoneKey)
  return entry?.subsections.map((subsection) => [
    subsection.label,
    subsection.firstCellId,
    subsection.cellIds.length,
    subsection.handSetCellId,
  ])
}

describe("AQU-2190 — a chapter's nested sub-entries", () => {
  it("keeps the top-level entries identical to the unmarked file", () => {
    const marked = store()
    marked.replaceRows(markFile({ 4: "The calming of the storm" }))
    const plain = store()
    plain.replaceRows(markFile())

    const summarize = (s: CellStore) => s.getNavigationIndex().map((entry) => [
      entry.key, entry.label, entry.firstCellId, entry.total, entry.translated, entry.validated,
    ])
    // Compared against the file itself rather than a hand-written list: the AC
    // is "nothing else moves", and anything this change disturbed at top level
    // would show up here whatever it was.
    expect(summarize(marked)).toEqual(summarize(plain))
  })

  it("lists the named section nested under its chapter, with the verses from its own cell on", () => {
    const s = store()
    s.replaceRows(markFile({ 4: "The calming of the storm" }))

    expect(subEntriesOf(s, "scripture:MRK:4")).toEqual([
      // The verses above the marker: still the chapter's own, numbered as a range.
      ["1–3", "mrk4-1", 3, undefined],
      ["The calming of the storm", "mrk4-4", 2, "mrk4-4"],
    ])
    // And the neighbours have no nested rows of their own.
    expect(subEntriesOf(s, "scripture:MRK:3")).toEqual([["1–1", "mrk3-1", 1, undefined]])
  })

  it("gives each sub-entry the figures of its own verses, and leaves the chapter's alone", () => {
    // 4:1 and 4:5 translated — one on each side of the marker, so a sub-entry
    // that counted the whole chapter (or only part of it) could not pass.
    const s = store()
    s.replaceRows(markFile({ 4: "The calming of the storm" }, [1, 5]))

    const chapter = s.getNavigationIndex().find((entry) => entry.key === "scripture:MRK:4")
    expect([chapter?.translated, chapter?.total]).toEqual([2, 5])
    expect(chapter?.subsections.map((sub) => [sub.label, sub.translated, sub.total])).toEqual([
      ["1–3", 1, 3],
      ["The calming of the storm", 1, 2],
    ])
  })

  it("splits the chapter at a second marker", () => {
    const s = store()
    s.replaceRows(markFile({ 1: "Parables", 4: "The calming of the storm" }))

    expect(subEntriesOf(s, "scripture:MRK:4")).toEqual([
      ["Parables", "mrk4-1", 3, "mrk4-1"],
      ["The calming of the storm", "mrk4-4", 2, "mrk4-4"],
    ])
  })

  it("returns the chapter to exactly how it looked once the sections are removed", () => {
    const s = store()
    s.replaceRows(markFile({ 1: "Parables", 4: "The calming of the storm" }))
    s.applyOptimisticCellMilestone("mrk4-1", null)
    s.applyOptimisticCellMilestone("mrk4-4", null)

    const plain = store()
    plain.replaceRows(markFile())
    const summarize = (candidate: CellStore) => candidate.getNavigationIndex().map((entry) => [
      entry.key, entry.label, entry.total, entry.subsections.map((sub) => sub.label),
    ])
    expect(summarize(s)).toEqual(summarize(plain))
  })

  it("re-divides when a marker arrives as one cell's row, with no reload", () => {
    // The collaborator case: a second member names a pericope and the row
    // lands on its own, not through a whole-file read.
    const s = store()
    s.replaceRows(markFile())
    expect(subEntriesOf(s, "scripture:MRK:4")).toEqual([["1–5", "mrk4-1", 5, undefined]])

    s.replaceRowsForCell("mrk4-4", [
      row("mrk4-4", "source", "mark 4:4", {
        canonicalRef: "MRK 4:4",
        milestoneLabel: "The calming of the storm",
      }),
      row("mrk4-4", "target", ""),
    ])

    expect(subEntriesOf(s, "scripture:MRK:4")).toEqual([
      ["1–3", "mrk4-1", 3, undefined],
      ["The calming of the storm", "mrk4-4", 2, "mrk4-4"],
    ])
  })
})

describe("AQU-2190 — a long division that already numbers its cells", () => {
  /** One 120-cell IDML story: a division the FILE supplied, long enough that
   *  the store chunks it into automatic 50-cell ranges. */
  function storyFile(marks: Record<number, string> = {}): CellRow[] {
    const milestone = { key: "story:1", kind: "story", label: "Story 1", shortLabel: "1" }
    return Array.from({ length: 120 }, (_, index) => row(
      `s${index}`,
      "source",
      `frame ${index}`,
      { milestone, milestoneLabel: marks[index] },
    ))
  }

  it("replaces the automatic ranges from the marker on, and keeps the ones before it", () => {
    const s = store()
    s.replaceRows(storyFile({ 70: "The reveal" }))

    expect(subEntriesOf(s, "story:1")).toEqual([
      // Untouched: wholly above the marker.
      ["1–50", "s0", 50, undefined],
      // Truncated at the marker rather than running to s99…
      ["51–70", "s50", 20, undefined],
      // …and the 101–120 range is gone, swallowed by the named section.
      ["The reveal", "s70", 50, "s70"],
    ])
  })

  it("still groups the story as one top-level entry holding all 120 cells", () => {
    const s = store()
    s.replaceRows(storyFile({ 70: "The reveal" }))
    const entry = s.getNavigationIndex().find((candidate) => candidate.key === "story:1")

    expect([entry?.label, entry?.cellIds.length, entry?.total]).toEqual(["Story 1", 120, 120])
  })
})

describe("AQU-2190 — the menu answers for a nested section", () => {
  it("offers Rename/Remove on the marked cell inside a chapter", () => {
    const s = store()
    s.replaceRows(markFile({ 4: "The calming of the storm" }))

    // The same answer AQU-2186 reads for a top-level section, so the marked
    // cell's menu swaps "Start a section here" for the pair either way.
    expect([...s.getHandSetSectionLabels()]).toEqual([
      ["mrk4-4", "The calming of the storm"],
    ])
  })

  it("offers starting a section on every verse, including inside the chapter", () => {
    const s = store()
    s.replaceRows(markFile())
    const ids = s.getCellIdsWhereSectionMayStart()

    expect(ids.has("mrk4-1")).toBe(true)
    expect(ids.has("mrk4-5")).toBe(true)
    expect(ids.has("mrk3-1")).toBe(true)
  })

  it("offers nothing for a label the derivation never placed", () => {
    // A label on a cell that is not in the navigation at all must not offer a
    // rename for a section nobody can see — the reason both answers are read
    // off the navigation rather than off the row.
    const s = store()
    s.replaceRows(markFile())
    expect(s.getHandSetSectionLabels().has("nope")).toBe(false)
    expect(s.getCellIdsWhereSectionMayStart().has("nope")).toBe(false)
  })
})
