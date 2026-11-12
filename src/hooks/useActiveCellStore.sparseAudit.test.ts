// AQU-2094 — a sparse audit read lists only cells someone has validated or
// waived. WHY these tests: a cell it leaves out has NO validators, and that is
// an answer. If the store read "missing" as "not loaded" it would fall back to
// the row's denormalized `validated` column, which a validation event never
// refreshes — the AQU-1364 bug, where an unvalidated cell kept reading
// validated and pinned the health bar at 100%.
import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { CellAuditStats } from "./useCellsAuditStats"
import { CellStore } from "./useActiveCellStore"

function row(cellId: string, side: "source" | "target", value: string, over: Partial<CellRow> = {}): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef: `GEN 1:${cellId === "a" ? 1 : 2}`,
    anchorCellId: null,
    eventId: `${side}-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: false,
    wordCount: 1,
    endorsementCount: 0,
    ...over,
  }
}

const validatedBy = (cellId: string, ...activeValidators: string[]): CellAuditStats => ({
  cellId,
  editCount: 1,
  contentHash: "",
  lastEditAt: 1,
  lastEditEventId: `target-${cellId}`,
  activeValidators,
  waivers: [],
})

// `a`'s row still says validated: someone unvalidated it since the row was read.
const ROWS = [
  row("a", "source", "In the beginning"),
  row("a", "target", "Au commencement", { validated: true, endorsementCount: 1 }),
  row("b", "source", "God created"),
  row("b", "target", "Dieu créa"),
]

function storeWith(auditStats: ReadonlyMap<string, CellAuditStats>, auditStatsComplete: boolean): CellStore {
  const store = new CellStore()
  store.setRuntime({ projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats, auditStatsComplete })
  store.replaceRows(ROWS)
  return store
}

describe("CellStore — sparse audit reads (AQU-2094)", () => {
  it("reads a cell a sparse answer leaves out as unvalidated, whatever its row says", () => {
    const store = storeWith(new Map([["b", validatedBy("b", "bob")]]), true)
    expect(store.getCellView("a")?.validationStatus).toBe("none")
    expect(store.getCellView("b")?.activeValidators).toEqual(["bob"])
    expect(store.getFileProgressSnapshot()?.file.validatedCount).toBe(1)
  })

  it("still falls back to the row while no complete answer has arrived", () => {
    const store = storeWith(new Map(), false)
    expect(store.getCellView("a")?.validationStatus).not.toBe("none")
    expect(store.getFileProgressSnapshot()?.file.validatedCount).toBe(1)
  })

  it("refreshes a cell the sparse answer does not mention when that answer arrives", () => {
    const store = storeWith(new Map(), false)
    const seen = store.getCellVersion("a")
    expect(store.getCellView("a")?.validationStatus).not.toBe("none")

    store.setRuntime({ projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map([["b", validatedBy("b", "bob")]]), auditStatsComplete: true })

    expect(store.getCellVersion("a")).not.toBe(seen)
    expect(store.getCellView("a")?.validationStatus).toBe("none")
    expect(store.getFileProgressSnapshot()?.file.validatedCount).toBe(1)
  })

  it("drops a cell's validators when a later sparse answer leaves it out", () => {
    const store = storeWith(new Map([["b", validatedBy("b", "bob")]]), true)
    expect(store.getFileProgressSnapshot()?.file.validatedCount).toBe(1)

    store.setRuntime({ projectId: "p", fileId: "f", username: "alice", requiredValidations: 1, auditStats: new Map(), auditStatsComplete: true })

    expect(store.getCellView("b")?.validationStatus).toBe("none")
    expect(store.getFileProgressSnapshot()?.file.validatedCount).toBe(0)
  })
})
