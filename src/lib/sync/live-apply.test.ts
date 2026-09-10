// Live apply of `event.applied` frames carrying projected rows.
//
// WHY: every remote edit used to cost a frame → GET round trip before the
// row repainted. With rows on the frame the store must land them directly —
// but a late older frame must never roll a cell back, and a frame without
// rows must keep the old refetch path alive so older sync-workers still work.

import { describe, expect, it, vi } from "vitest"
import type { CellRow } from "./cells-read-types"
import { CellStore } from "@/hooks/useActiveCellStore"
import { createLiveApplier, shouldApplyFrame, type AppliedEventFrame } from "./live-apply"

function row(
  cellId: string,
  side: "source" | "target",
  value: string,
  eventId: string,
): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef: "GEN 1:1",
    anchorCellId: null,
    eventId,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: false,
    wordCount: value ? value.trim().split(/\s+/).length : 0,
  }
}

function makeStore(rows: CellRow[]): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: "p1",
    fileId: "f1",
    username: "me",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(rows, { full: true })
  return store
}

function frame(over: Partial<AppliedEventFrame>): AppliedEventFrame {
  return {
    t: "event.applied",
    id: "evt",
    kind: "target.cell.commit",
    project: "p1",
    file: "f1",
    cell: "c1",
    by: "alice",
    ...over,
  }
}

const SOURCE = row("c1", "source", "In the beginning", "S0")

describe("createLiveApplier", () => {
  it("lands frame rows in the store directly — no refetch", () => {
    const store = makeStore([SOURCE, row("c1", "target", "old", "H")])
    const revalidateCell = vi.fn()
    const applier = createLiveApplier({ store, revalidateCell })

    const result = applier.apply(
      frame({ serverSeq: 10, rows: [SOURCE, row("c1", "target", "En el principio", "E1")] }),
    )

    expect(result).toBe("applied")
    expect(revalidateCell).not.toHaveBeenCalled()
    const view = store.getCellView("c1")
    expect(view?.targetEventId).toBe("E1")
    expect(view?.translated).toBe("En el principio")
  })

  it("ignores an older frame that arrives late (never rolls the cell back)", () => {
    const store = makeStore([SOURCE, row("c1", "target", "old", "H")])
    const applier = createLiveApplier({ store, revalidateCell: vi.fn() })
    applier.apply(
      frame({ serverSeq: 10, rows: [SOURCE, row("c1", "target", "En el principio", "E1")] }),
    )

    const result = applier.apply(
      frame({ serverSeq: 9, rows: [SOURCE, row("c1", "target", "old", "H")] }),
    )

    expect(result).toBe("ignored")
    expect(store.getCellView("c1")?.targetEventId).toBe("E1")
    expect(store.getCellView("c1")?.translated).toBe("En el principio")
  })

  it("falls back to revalidateCell when the frame carries no rows (legacy worker)", () => {
    const store = makeStore([SOURCE, row("c1", "target", "old", "H")])
    const revalidateCell = vi.fn()
    const applier = createLiveApplier({ store, revalidateCell })

    expect(applier.apply(frame({}))).toBe("refetch")
    expect(revalidateCell).toHaveBeenCalledTimes(1)
    expect(revalidateCell).toHaveBeenCalledWith("c1")
    expect(store.getCellView("c1")?.targetEventId).toBe("H")
  })

  it("falls back to revalidateCell when rows arrive without a serverSeq", () => {
    const store = makeStore([SOURCE])
    const revalidateCell = vi.fn()
    const applier = createLiveApplier({ store, revalidateCell })

    expect(applier.apply(frame({ rows: [SOURCE] }))).toBe("refetch")
    expect(revalidateCell).toHaveBeenCalledTimes(1)
  })

  it("keeps a newer in-flight local edit painting over applied rows", () => {
    // The user typed "v2" after the server projected "v1"; the frame for v1
    // lands first. Rows replace the base, but the shadow (value != row) is
    // kept by clearConfirmedShadows, so the view still shows the local edit.
    const store = makeStore([SOURCE, row("c1", "target", "old", "H")])
    store.applyOptimisticTargetEdit("c1", { value: "v2" })
    const applier = createLiveApplier({ store, revalidateCell: vi.fn() })

    const result = applier.apply(
      frame({ serverSeq: 10, rows: [SOURCE, row("c1", "target", "v1", "E1")] }),
    )

    expect(result).toBe("applied")
    expect(store.getCellView("c1")?.translated).toBe("v2")
    expect(store.getCellView("c1")?.targetEventId).toBe("E1")
  })

  it("clears the optimistic shadow when the rows confirm it (own-write echo)", () => {
    const store = makeStore([SOURCE, row("c1", "target", "old", "H")])
    store.applyOptimisticTargetEdit("c1", { value: "mine" })
    const applier = createLiveApplier({ store, revalidateCell: vi.fn() })

    applier.apply(
      frame({ by: "me", serverSeq: 10, rows: [SOURCE, row("c1", "target", "mine", "E1")] }),
    )

    expect(store.getCellView("c1")?.translated).toBe("mine")
    expect(store.getCellView("c1")?.targetEventId).toBe("E1")
    // Shadow gone: the base row now speaks for itself.
    expect(store.clearOptimisticIfValue("c1", "mine")).toBe(false)
  })

  it("reset() forgets per-cell ordering so a new file starts clean", () => {
    const store = makeStore([SOURCE, row("c1", "target", "old", "H")])
    const applier = createLiveApplier({ store, revalidateCell: vi.fn() })
    applier.apply(frame({ serverSeq: 10, rows: [SOURCE, row("c1", "target", "a", "E1")] }))
    applier.reset()

    const result = applier.apply(
      frame({ serverSeq: 3, rows: [SOURCE, row("c1", "target", "b", "E2")] }),
    )

    expect(result).toBe("applied")
    expect(store.getCellView("c1")?.targetEventId).toBe("E2")
  })
})

describe("shouldApplyFrame", () => {
  it("refetches without cell, rows, or serverSeq", () => {
    expect(shouldApplyFrame({ cell: "c" }, undefined)).toBe("refetch")
    expect(shouldApplyFrame({ cell: "c", rows: [] }, undefined)).toBe("refetch")
    expect(shouldApplyFrame({ cell: "c", serverSeq: 1 }, undefined)).toBe("refetch")
    expect(shouldApplyFrame({ rows: [], serverSeq: 1 }, undefined)).toBe("refetch")
  })

  it("ignores strictly older frames, applies equal or newer", () => {
    const f = { cell: "c", rows: [], serverSeq: 5 }
    expect(shouldApplyFrame(f, 6)).toBe("ignore")
    expect(shouldApplyFrame(f, 5)).toBe("apply")
    expect(shouldApplyFrame(f, 4)).toBe("apply")
    expect(shouldApplyFrame(f, undefined)).toBe("apply")
  })
})
