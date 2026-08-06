/**
 * AQU-803: CellStore.removeCellOptimistically — the optimistic-delete path for
 * the delete-a-cell editor affordance. Deleting a cell must drop it from the
 * view the instant the user confirms (before the source.cell.delete /
 * target.cell.delete events round-trip), and it must not be resurrected by an
 * in-flight (pre-delete) refetch's buffer swap.
 */
import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "./useActiveCellStore"

function row(
  cellId: string,
  side: "source" | "target",
  value: string,
  targetLang?: string,
): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `${side}-${cellId}${targetLang ? `-${targetLang}` : ""}`,
    sourceEventId: null,
    lastEditor: "lead",
    lastEditAt: 1,
    validated: false,
    wordCount: value ? 1 : 0,
    ...(targetLang ? { targetLang } : {}),
  }
}

function makeStore(rows: CellRow[]): CellStore {
  const store = new CellStore()
  store.reset("project", "file")
  store.setRuntime({
    projectId: "project",
    fileId: "file",
    username: "lead",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(rows, { full: true, maxServerSeq: 1 })
  return store
}

describe("CellStore.removeCellOptimistically (AQU-803)", () => {
  it("drops the cell (all sides) from the view immediately", () => {
    const store = makeStore([
      row("c1", "source", "one"),
      row("c2", "source", "two"),
      row("c1", "target", "uno"),
      row("c2", "target", "dos"),
    ])
    expect(store.getCellIds()).toEqual(["c1", "c2"])

    store.removeCellOptimistically("c1")

    expect(store.getCellIds()).toEqual(["c2"])
    expect(store.getCellView("c1")).toBeNull()
    expect(store.findIndexByCellId("c1")).toBe(-1)
    // The surviving cell is untouched and re-indexed to the front.
    expect(store.getCellView("c2")?.original).toBe("two")
    expect(store.findIndexByCellId("c2")).toBe(0)
  })

  it("removes every lane's target row, not just the active lane's", () => {
    const store = makeStore([
      row("c1", "source", "one"),
      row("c1", "target", "uno"), // default lane
      row("c1", "target", "un", "fr"), // sibling lane retained in otherLaneTargetRows
    ])
    store.removeCellOptimistically("c1")
    // toRows() must be lane-complete and hold nothing for the deleted cell.
    expect(store.toRows().some((r) => r.cellId === "c1")).toBe(false)
  })

  it("stamps a freshness floor so a stale in-flight refetch cannot resurrect it", () => {
    const store = makeStore([
      row("c1", "source", "one"),
      row("c1", "target", "uno"),
    ])
    // A soft fetch snapshot taken BEFORE the delete.
    const fetchStartSeq = store.getWriteSeq()

    store.removeCellOptimistically("c1")
    expect(store.getFreshnessFloor("c1")).toBeGreaterThan(fetchStartSeq)

    // The stale buffer still carries c1's rows (the server hadn't applied the
    // delete when the snapshot began). mergeProtectedRows must NOT re-add it:
    // c1 is protected (floor > fetchStartSeq) and the store has no current rows
    // for it, so the buffer's rows are discarded.
    const staleBuffer = [row("c1", "source", "one"), row("c1", "target", "uno")]
    const { rows: kept, discardedCellIds } = store.mergeProtectedRows(staleBuffer, fetchStartSeq)
    expect(kept.some((r) => r.cellId === "c1")).toBe(false)
    expect(discardedCellIds.has("c1")).toBe(true)
  })

  it("is a no-op-safe floor stamp for a cell not currently in the view", () => {
    const store = makeStore([row("c1", "source", "one")])
    // Deleting an id the view never had still stamps a floor (guards a racing
    // fetch) and leaves the existing cell untouched.
    store.removeCellOptimistically("ghost")
    expect(store.getFreshnessFloor("ghost")).toBeGreaterThan(0)
    expect(store.getCellIds()).toEqual(["c1"])
  })
})
