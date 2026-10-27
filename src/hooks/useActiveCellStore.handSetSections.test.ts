// AQU-2185 — hand-set sections in the store: the navigator, and the gate that
// decides where "Start a section here" is offered.
//
// Two jobs, and they are different:
//
//   * the NAVIGATOR entries the picker, the previous/next steps and the
//     Split-into-milestones pages are all built from, which must re-divide the
//     moment a marker lands — including when it arrives as one cell's row from
//     a collaborator, with no reload;
//   * `getCellIdsWhereSectionMayStart`, which is the UI gate. It has to be read
//     off the navigation the navigator is actually showing: whether a division
//     came out of the file is a property of the stretch a cell landed in, so no
//     cell can answer it from its own row.

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
    // Absent, not empty, on an unmarked row — the server omits the key rather
    // than sending it on every one of a Bible file's 30k rows, and a fixture
    // that sent `""` would not exercise the shape the app receives.
    ...(opts.milestoneLabel ? { milestoneLabel: opts.milestoneLabel } : {}),
  }
}

/** A plain 120-line file: the navigator shows Part 1, Part 2, Part 3.
 *  Every line carries a target row as well, because the per-cell ingestion
 *  path's "nothing moved" branch is only reachable when both sides are
 *  present — a source-only fixture would take the full rebuild for free and
 *  prove nothing about the field list. */
function plainFile(marks: Record<number, string> = {}): CellRow[] {
  const rows: CellRow[] = []
  for (let n = 0; n < 120; n++) {
    rows.push(row(`c${n}`, "source", `line ${n}`, { milestoneLabel: marks[n] }))
    rows.push(row(`c${n}`, "target", ""))
  }
  return rows
}

/** A Scripture file, whose divisions come out of the file itself. */
function scriptureFile(): CellRow[] {
  const rows: CellRow[] = []
  for (let n = 1; n <= 6; n++) {
    rows.push(row(`gen-${n}`, "source", `verse ${n}`, { canonicalRef: `GEN 1:${n}` }))
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

describe("AQU-2185 — the navigator re-divides around a hand-set section", () => {
  it("lists the named section in place of the app-made divisions it swallowed", () => {
    const s = store()
    s.replaceRows(plainFile({ 70: "The storm" }))

    expect(s.getNavigationIndex().map((e) => [e.label, e.firstCellId, e.total])).toEqual([
      ["Part 1", "c0", 50],
      // Ends just above the marked cell…
      ["Part 2", "c50", 20],
      // …and "Part 3" is gone, swallowed by the section.
      ["The storm", "c70", 50],
    ])
  })

  it("gives the section its own progress figures, like any other entry", () => {
    // Three of the section's 50 cells translated, and one of those validated.
    const translated = new Map<string, CellRow>([
      ["c70", row("c70", "target", "drafted")],
      ["c71", row("c71", "target", "drafted")],
      ["c72", { ...row("c72", "target", "drafted"), validated: true }],
    ])
    const rows = plainFile({ 70: "The storm" }).map((r) => (
      r.side === "target" && translated.has(r.cellId) ? translated.get(r.cellId)! : r
    ))
    const s = store()
    s.replaceRows(rows)

    const section = s.getNavigationIndex().find((e) => e.label === "The storm")
    expect(section).toMatchObject({ total: 50, translated: 3, validated: 1 })
    // And the untouched divisions above it still report their own.
    expect(s.getNavigationIndex().find((e) => e.label === "Part 1")).toMatchObject({
      total: 50, translated: 0,
    })
  })

  it("re-divides when a marker arrives for one cell, with no reload", () => {
    // The regression this guards: the navigation STRUCTURE is cached per id
    // list and compared field by field, so a row whose only change was its
    // label would have been served from the cache — the collaborator's new
    // division would not appear until something else about the file moved.
    const s = store()
    s.replaceRows(plainFile())
    expect(s.getNavigationIndex().map((e) => e.label)).toEqual(["Part 1", "Part 2", "Part 3"])

    // Both sides, and nothing but the label differs — so the per-cell path's
    // field-by-field comparison is what has to notice it.
    s.replaceRowsForCell("c70", [
      row("c70", "source", "line 70", { milestoneLabel: "The storm" }),
      row("c70", "target", ""),
    ])
    expect(s.getNavigationIndex().map((e) => e.label)).toEqual(["Part 1", "Part 2", "The storm"])

    // …and clearing it puts the file's own divisions back.
    s.replaceRowsForCell("c70", [row("c70", "source", "line 70"), row("c70", "target", "")])
    expect(s.getNavigationIndex().map((e) => e.label)).toEqual(["Part 1", "Part 2", "Part 3"])
  })

  it("applies a marker optimistically and rolls it back to the previous label", () => {
    const s = store()
    s.replaceRows(plainFile())

    // `null` is the real previous value of an unmarked cell, and is what a
    // rollback must restore — which is why "no such row" is `undefined`.
    expect(s.applyOptimisticCellMilestone("c70", "The storm")).toBeNull()
    expect(s.getNavigationIndex().map((e) => e.label)).toEqual(["Part 1", "Part 2", "The storm"])

    const previous = s.applyOptimisticCellMilestone("c70", "The calm")
    expect(previous).toBe("The storm")
    expect(s.getNavigationIndex().map((e) => e.label)).toEqual(["Part 1", "Part 2", "The calm"])

    // The server refuses: back to what it was, not to unmarked. `?? null` only
    // satisfies the signature's `string | null` — the assertion above is what
    // pins the value, so an `undefined` here would already have failed.
    s.applyOptimisticCellMilestone("c70", previous ?? null)
    expect(s.getNavigationIndex().map((e) => e.label)).toEqual(["Part 1", "Part 2", "The storm"])
  })

  it("reports no row to mark rather than a previous label of null", () => {
    const s = store()
    s.replaceRows(plainFile())
    // `undefined` ⇒ nothing was done and nothing needs rolling back. Confusing
    // this with `null` would make the caller "restore" a section onto a cell
    // that never had one.
    expect(s.applyOptimisticCellMilestone("no-such-cell", "The storm")).toBeUndefined()
  })

  it("treats a blank name as clearing the marker, not as a section called nothing", () => {
    const s = store()
    s.replaceRows(plainFile({ 70: "The storm" }))

    s.applyOptimisticCellMilestone("c70", "   ")
    expect(s.getNavigationIndex().map((e) => e.label)).toEqual(["Part 1", "Part 2", "Part 3"])
  })
})

describe("AQU-2185 — where the action may be offered", () => {
  it("offers it across the app-made divisions of a plain file", () => {
    const s = store()
    s.replaceRows(plainFile())
    const ids = s.getCellIdsWhereSectionMayStart()

    expect(ids.size).toBe(120)
    expect(ids.has("c0")).toBe(true)
    expect(ids.has("c119")).toBe(true)
  })

  it("keeps offering it inside a section that is already hand-set, so a second marker splits it", () => {
    const s = store()
    s.replaceRows(plainFile({ 70: "The storm" }))
    const ids = s.getCellIdsWhereSectionMayStart()

    expect(ids.has("c70")).toBe(true)
    expect(ids.has("c100")).toBe(true)
  })

  it("offers it nowhere in a file whose divisions came out of the file", () => {
    // The AC: a Scripture file's cells do not offer the action, and its chapters
    // are unchanged. Inside those, a marker becomes a sub-entry — AQU-2190's
    // slice, not this one's.
    const s = store()
    s.replaceRows(scriptureFile())

    expect(s.getNavigationIndex().map((e) => e.kind)).toEqual(
      new Array(1).fill("chapter"),
    )
    expect(s.getCellIdsWhereSectionMayStart().size).toBe(0)
  })
})
