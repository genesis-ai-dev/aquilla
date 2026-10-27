// AQU-2186 — which cells may be renamed or removed, and what the navigator
// does when they are.
//
// `getHandSetSectionLabels` is the UI gate's second half. Its companion from
// AQU-2185, `getCellIdsWhereSectionMayStart`, returns every cell a hand-set
// section COVERS; this one returns only the cells that START one, with the
// name each carries. The row needs both to choose between "Start a section
// here" and the Rename/Remove pair, and getting them the wrong way round would
// offer Rename on every cell of a section — 50 menus all pointing at one
// marker.
//
// Read off the NAVIGATION, never off the row's own `milestoneLabel`: a label
// the derivation placed nowhere would otherwise offer a rename for a section
// nobody can see. Since AQU-2190 a label inside a division the file supplied
// IS placed — as a sub-entry nested under it — and the pair is offered there
// too, by the same rule and from the same answer.

import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "./useActiveCellStore"

function row(
  cellId: string,
  side: "source" | "target",
  value: string,
  opts: { milestoneLabel?: string; canonicalRef?: string | null } = {},
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
    validated: false,
    wordCount: value ? 1 : 0,
    endorsementCount: 0,
    metadata: null,
    ...(opts.milestoneLabel ? { milestoneLabel: opts.milestoneLabel } : {}),
  }
}

function plainFile(marks: Record<number, string> = {}): CellRow[] {
  const rows: CellRow[] = []
  for (let n = 0; n < 120; n++) {
    rows.push(row(`c${n}`, "source", `line ${n}`, { milestoneLabel: marks[n] }))
    rows.push(row(`c${n}`, "target", ""))
  }
  return rows
}

/** A Scripture file: its divisions come out of the file, so a label on one of
 *  its cells is ignored by the derivation. */
function scriptureFile(marks: Record<number, string> = {}): CellRow[] {
  const rows: CellRow[] = []
  for (let n = 1; n <= 6; n++) {
    rows.push(row(`gen-${n}`, "source", `verse ${n}`, {
      canonicalRef: `GEN 1:${n}`,
      milestoneLabel: marks[n],
    }))
  }
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

const labels = (s: CellStore) => s.getNavigationIndex().map((e) => e.label)

describe("AQU-2186 — which cells offer Rename section… and Remove section", () => {
  it("names only the marked cell, with the section's current name", () => {
    const s = store()
    s.replaceRows(plainFile({ 70: "The storm" }))

    expect([...s.getHandSetSectionLabels()]).toEqual([["c70", "The storm"]])
    // Every other cell of the section is covered by it but does not start it:
    // those rows keep offering "Start a section here", which splits it.
    expect(s.getCellIdsWhereSectionMayStart().has("c100")).toBe(true)
    expect(s.getHandSetSectionLabels().has("c100")).toBe(false)
  })

  it("names both markers when two sections are set", () => {
    const s = store()
    s.replaceRows(plainFile({ 60: "The storm", 90: "The calm" }))

    expect([...s.getHandSetSectionLabels()]).toEqual([
      ["c60", "The storm"],
      ["c90", "The calm"],
    ])
  })

  it("is empty on a file with no hand-set sections", () => {
    const s = store()
    s.replaceRows(plainFile())

    expect(s.getHandSetSectionLabels().size).toBe(0)
  })

  it("offers the pair on a Scripture cell's marker, which AQU-2190 nests under the chapter", () => {
    // AQU-2185 dropped a label here, so this used to offer nothing. AQU-2190
    // makes it a sub-entry under Genesis 1 — a section a reader can see, so it
    // is one they can rename, and the answer still comes from the navigation
    // rather than from the row's own column.
    const s = store()
    s.replaceRows(scriptureFile({ 3: "The calming of the storm" }))

    // The chapter itself is still the file's own single division.
    expect(s.getNavigationIndex().map((e) => e.kind)).toEqual(["chapter"])
    expect([...s.getHandSetSectionLabels()]).toEqual([
      ["gen-3", "The calming of the storm"],
    ])
    // A label the derivation placed NOWHERE is still offered nothing — the
    // invariant this case used to stand for, covered on an id the navigation
    // does not list (and again in useActiveCellStore.subEntries.test.ts).
    expect(s.getHandSetSectionLabels().has("gen-99")).toBe(false)
  })
})

describe("AQU-2186 — renaming", () => {
  it("shows the new name everywhere the section is listed, keeping its identity", () => {
    const s = store()
    s.replaceRows(plainFile({ 70: "The storm" }))
    const before = s.getNavigationIndex().find((e) => e.label === "The storm")

    s.applyOptimisticCellMilestone("c70", "Calming the storm")

    expect(labels(s)).toEqual(["Part 1", "Part 2", "Calming the storm"])
    const after = s.getNavigationIndex().at(-1)
    // Same key and same cells ⇒ the navigator's selection and the
    // Split-into-milestones page stay put across the rename.
    expect(after?.key).toBe(before?.key)
    expect(after?.cellIds).toEqual(before?.cellIds)
    expect(after?.total).toBe(before?.total)
    // …and the gate now opens the rename dialog on the new name.
    expect(s.getHandSetSectionLabels().get("c70")).toBe("Calming the storm")
  })

  it("picks up a collaborator's rename from one cell's row, with no reload", () => {
    const s = store()
    s.replaceRows(plainFile({ 70: "The storm" }))

    s.replaceRowsForCell("c70", [
      row("c70", "source", "line 70", { milestoneLabel: "Calming the storm" }),
      row("c70", "target", ""),
    ])

    expect(labels(s)).toEqual(["Part 1", "Part 2", "Calming the storm"])
  })
})

describe("AQU-2186 — removing", () => {
  it("brings back exactly the divisions the file showed before the section was set", () => {
    const s = store()
    s.replaceRows(plainFile())
    const before = s.getNavigationIndex().map((e) => [e.key, e.label, e.firstCellId, e.total])

    s.applyOptimisticCellMilestone("c70", "The storm")
    expect(labels(s)).toEqual(["Part 1", "Part 2", "The storm"])

    s.applyOptimisticCellMilestone("c70", null)

    // Compared against the file's own "before", so nothing — key, label,
    // boundary or count — may come back subtly different.
    expect(s.getNavigationIndex().map((e) => [e.key, e.label, e.firstCellId, e.total]))
      .toEqual(before)
    expect(s.getHandSetSectionLabels().size).toBe(0)
  })

  it("folds the removed section's cells into the section above it", () => {
    const s = store()
    s.replaceRows(plainFile({ 60: "The storm", 90: "The calm" }))
    expect(labels(s)).toEqual(["Part 1", "Part 2", "The storm", "The calm"])

    s.applyOptimisticCellMilestone("c90", null)

    expect(s.getNavigationIndex().map((e) => [e.label, e.firstCellId, e.total])).toEqual([
      ["Part 1", "c0", 50],
      ["Part 2", "c50", 10],
      // 30 of its own plus the 30 that were "The calm".
      ["The storm", "c60", 60],
    ])
    // The one that was left is still renameable; the removed one is not.
    expect([...s.getHandSetSectionLabels()]).toEqual([["c60", "The storm"]])
  })

  it("rolls back to the section when the server refuses the removal", () => {
    const s = store()
    s.replaceRows(plainFile({ 70: "The storm" }))

    const previous = s.applyOptimisticCellMilestone("c70", null)
    expect(previous).toBe("The storm")
    expect(labels(s)).toEqual(["Part 1", "Part 2", "Part 3"])

    s.applyOptimisticCellMilestone("c70", previous ?? null)
    expect(labels(s)).toEqual(["Part 1", "Part 2", "The storm"])
  })

  it("lets the same cell start a section again afterwards", () => {
    const s = store()
    s.replaceRows(plainFile({ 70: "The storm" }))

    s.applyOptimisticCellMilestone("c70", null)
    s.applyOptimisticCellMilestone("c70", "Second try")

    expect(labels(s)).toEqual(["Part 1", "Part 2", "Second try"])
    expect(s.getHandSetSectionLabels().get("c70")).toBe("Second try")
  })
})
