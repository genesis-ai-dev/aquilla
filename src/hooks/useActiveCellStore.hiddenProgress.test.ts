// AQU-1424 — a parked cell is not work, in the client's own progress numbers.
//
// The store's snapshot is the overlay the status bar, the file list and the
// project overview paint while an edit is in flight, so if it disagrees with the
// server's projection the percentage visibly jumps and settles. These tests pin
// the rule the server's SQL pins too: a hidden cell leaves the numerator AND the
// denominator, and is never counted back in by the structural policy.

import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "./useActiveCellStore"

function row(
  cellId: string,
  side: "source" | "target",
  value: string,
  canonicalRef: string | null,
  opts: { hidden?: boolean; type?: string | null } = {},
): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: opts.type ?? null,
    canonicalRef,
    anchorCellId: null,
    eventId: `${side}-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: false,
    wordCount: value ? 1 : 0,
    endorsementCount: 0,
    metadata: null,
    // Absent, not `false`, on a visible row — the server omits the key rather
    // than sending it on every one of a Bible file's 30k rows, and a fixture
    // that sent `false` would not exercise the shape the app actually receives.
    ...(opts.hidden ? { hidden: true as const } : {}),
  }
}

/** A 10-cell file, 9 of them translated; cell `c10` is the untranslated one. */
function tenCellFile(opts: { hideC10?: boolean } = {}): CellRow[] {
  const rows: CellRow[] = []
  for (let n = 1; n <= 10; n++) {
    const id = `c${n}`
    const ref = `GEN 1:${n}`
    const last = n === 10
    rows.push(row(id, "source", `Source ${n}`, ref, last ? { hidden: opts.hideC10 } : {}))
    if (!last) rows.push(row(id, "target", `Draft ${n}`, ref))
  }
  return rows
}

function store(): CellStore {
  const s = new CellStore()
  s.setRuntime({
    projectId: "p",
    fileId: "f",
    username: "alice",
    requiredValidations: 2,
    auditStats: new Map(),
  })
  return s
}

describe("AQU-1424 — hidden cells leave the client's progress", () => {
  it("drops a hidden cell from both the numerator and the denominator", () => {
    const visible = store()
    visible.replaceRows(tenCellFile())
    expect(visible.getFileProgressSnapshot()?.file).toMatchObject({
      totalCount: 10,
      filledCount: 9,
    })

    const hidden = store()
    hidden.replaceRows(tenCellFile({ hideC10: true }))
    // 9 of 9, not 9 of 10 — the AC's "hiding the untranslated cell shows 100%".
    expect(hidden.getFileProgressSnapshot()?.file).toMatchObject({
      totalCount: 9,
      filledCount: 9,
    })
  })

  it("a file with nothing hidden reports exactly what it did before", () => {
    const before = store()
    before.replaceRows(tenCellFile())
    const after = store()
    after.replaceRows(tenCellFile({ hideC10: false }))
    expect(after.getFileProgressSnapshot()?.file).toEqual(before.getFileProgressSnapshot()?.file)
    expect(after.getFileProgressSnapshot()?.sections).toEqual(before.getFileProgressSnapshot()?.sections)
  })

  it("moves the figure on a hide that arrives for one cell, with no reload", () => {
    // The regression this guards: the per-cell ingestion path enumerates the
    // fields it considers, and a row whose ONLY change was `hidden` took its
    // "nothing moved" branch — so the percentage sat still until a remount.
    const s = store()
    s.replaceRows(tenCellFile())
    expect(s.getFileProgressSnapshot()?.file.totalCount).toBe(10)

    s.replaceRowsForCell("c10", [row("c10", "source", "Source 10", "GEN 1:10", { hidden: true })])
    expect(s.getFileProgressSnapshot()?.file).toMatchObject({ totalCount: 9, filledCount: 9 })

    // ...and showing it again puts the work back.
    s.replaceRowsForCell("c10", [row("c10", "source", "Source 10", "GEN 1:10")])
    expect(s.getFileProgressSnapshot()?.file).toMatchObject({ totalCount: 10, filledCount: 9 })
  })

  it("keeps a hidden cell out of the chapter fraction", () => {
    const s = store()
    s.replaceRows(tenCellFile({ hideC10: true }))
    const chapter = s.getNavigationIndex()[0]
    expect(chapter).toBeDefined()
    expect({ translated: chapter.translated, total: chapter.total }).toEqual({ translated: 9, total: 9 })
  })

  it("does not count a hidden cell back in for a project that counts headings", () => {
    // Structural policy and hiding are different questions: turning headings ON
    // must not resurrect a parked heading.
    const s = new CellStore()
    s.setRuntime({
      projectId: "p",
      fileId: "f",
      username: "alice",
      requiredValidations: 2,
      auditStats: new Map(),
      countStructural: true,
    })
    s.replaceRows([
      row("h1", "source", "Chapter One", "GEN 1:0", { type: "heading", hidden: true }),
      row("c1", "source", "Source 1", "GEN 1:1"),
      row("c1", "target", "Draft 1", "GEN 1:1"),
    ])
    expect(s.getFileProgressSnapshot()?.file).toMatchObject({ totalCount: 1, filledCount: 1 })
  })

  it("carries the flag onto the cell summary so health and drafting can read it", () => {
    const s = store()
    s.replaceRows(tenCellFile({ hideC10: true }))
    expect(s.getCellSummary("c10")?.hidden).toBe(true)
    expect(s.getCellSummary("c1")?.hidden).toBeUndefined()
  })
})
