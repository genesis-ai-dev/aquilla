// Regression tests for the stale-row bug (predict/validate updated the footer
// but not the editor row until a manual refresh).
//
// Editor rows read via useCellView, which wires useSyncExternalStore to
// getCellVersion(cellId). React bails out of the re-render whenever
// getSnapshot returns a value the row already rendered with — so a version
// number, once observed for a cell, may NEVER be produced again. The old
// per-cell counters restarted at 0 on reset() (which also skipped the
// per-cell listeners), then silently re-inflated through bumpAllCells()
// (audit-stats churn notifies only the audit-changed cells): a later real
// data change could land exactly on an already-rendered number and the row
// stayed stale until remount, while the footer (subscribeAll → fileVersion)
// kept updating.
import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { mergeCellsDelta } from "@/lib/sync/cells-cache"
import type { CellAuditStats } from "./useCellsAuditStats"
import { CellStore } from "./useActiveCellStore"

function stats(cellId: string, activeValidators: string[]): CellAuditStats {
  return {
    cellId,
    editCount: 0,
    contentHash: "",
    lastEditAt: null,
    lastEditEventId: null,
    activeValidators,
    waivers: [],
  }
}

function row(
  cellId: string,
  side: "source" | "target",
  value: string,
  over: Partial<CellRow> = {},
): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `${side}-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: false,
    wordCount: value ? 1 : 0,
    endorsementCount: 0,
    ...over,
  }
}

function runtime(store: CellStore, auditStats: ReadonlyMap<string, CellAuditStats>): void {
  store.setRuntime({
    projectId: "p1",
    fileId: "f1",
    username: "alice",
    requiredValidations: 1,
    auditStats,
  })
}

describe("CellStore per-cell versions", () => {
  it("never re-issues a version a cell has already reported, even across reset()", () => {
    const store = new CellStore()
    runtime(store, new Map())
    store.replaceRows([row("a", "source", "hello"), row("b", "source", "world")])

    // Inflate cell a's version the way audit-stats churn does in production:
    // each new auditStats map identity bumps ALL cells (bumpAllCells) while
    // only the audit-changed cell gets a per-cell emit.
    for (let i = 0; i < 8; i++) {
      runtime(store, new Map([["b", stats("b", [`v${i}`])]]))
    }
    const seenByRow = store.getCellVersion("a")
    expect(seenByRow).toBeGreaterThan(0)

    // File switch and back: reset() used to zero the counters, letting them
    // silently climb back through already-rendered values.
    store.reset("p1", "f1")
    store.replaceRows([row("a", "source", "hello"), row("b", "source", "world")])
    for (let i = 0; i < 5; i++) {
      runtime(store, new Map([["b", stats("b", [`w${i}`])]]))
    }

    // The data change a stale row is waiting on: its version must be strictly
    // newer than anything the row could have rendered with before.
    store.applyOptimisticTargetEdit("a", { value: "hola" })
    expect(store.getCellVersion("a")).toBeGreaterThan(seenByRow)
  })

  it("versions strictly increase across every mutation for a cell", () => {
    const store = new CellStore()
    runtime(store, new Map())
    const seen: number[] = []
    store.replaceRows([row("a", "source", "hello")])
    seen.push(store.getCellVersion("a"))
    store.applyOptimisticTargetEdit("a", { value: "hola" })
    seen.push(store.getCellVersion("a"))
    store.setPendingOverlay(new Map([["a", { value: "hola!" }]]))
    seen.push(store.getCellVersion("a"))
    store.replaceRowsForCell("a", [row("a", "source", "hello"), row("a", "target", "hola!")])
    seen.push(store.getCellVersion("a"))
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1])
    }
  })

  it("never bumps a cell's version without notifying its subscriber (audit-stats churn)", () => {
    // The stale-row failure needed ~940 silent bumps: setRuntime used to bump
    // EVERY cell on each new auditStats map while emitting only the audit-
    // changed ones, so a parent-driven render could consume a version number
    // whose data hadn't arrived yet.
    const store = new CellStore()
    runtime(store, new Map())
    store.replaceRows([row("a", "source", "hello"), row("b", "source", "world")])
    const before = store.getCellVersion("a")
    let notified = 0
    store.subscribeCell("a", () => { notified++ })
    for (let i = 0; i < 5; i++) {
      runtime(store, new Map([["b", stats("b", [`v${i}`])]]))
    }
    // b changed, a did not: a's version must not move behind its subscriber's back.
    expect(store.getCellVersion("a")).toBe(before)
    expect(notified).toBe(0)
    expect(store.getCellVersion("b")).toBeGreaterThan(before)
  })

  it("applyOptimisticTargetEdit notifies the subscriber even when no source row exists yet", () => {
    // Mid-refetch/reset window: the shadow is written into optimisticEdits
    // (and getCellView overlays it), so the early "no source row" return must
    // still bump + emit — the AI-batch stale rows were writes down this path.
    const store = new CellStore()
    runtime(store, new Map())
    store.replaceRows([row("a", "source", "hello")])
    // Simulate the torn window: a targeted refetch response without rows
    // removes both sides for the cell while keeping it subscribed.
    store.replaceRowsForCell("a", [])
    const before = store.getCellVersion("a")
    let notified = 0
    store.subscribeCell("a", () => { notified++ })
    store.applyOptimisticTargetEdit("a", { value: "hola", aiDrafted: true })
    expect(notified).toBeGreaterThan(0)
    expect(store.getCellVersion("a")).toBeGreaterThan(before)
  })

  it("overlays recompute validationStatus so an optimistic value never reads as 'empty'", () => {
    const store = new CellStore()
    runtime(store, new Map())
    store.replaceRows([row("a", "source", "hello"), row("a", "target", "")])
    expect(store.getCellView("a")?.validationStatus).toBe("empty")
    store.applyOptimisticTargetEdit("a", { value: "hola", aiDrafted: true })
    const view = store.getCellView("a")
    expect(view?.translated).toBe("hola")
    expect(view?.validationStatus).not.toBe("empty")
  })

  it("notifies per-cell subscribers on reset() so rows drop the old file's content", () => {
    const store = new CellStore()
    runtime(store, new Map())
    store.replaceRows([row("a", "source", "hello"), row("a", "target", "hola")])
    let notified = 0
    store.subscribeCell("a", () => { notified++ })
    store.reset("p1", "f2")
    expect(notified).toBeGreaterThan(0)
    expect(store.getCellView("a")).toBeNull()
  })

  it("keeps every target-language lane when a protected delta races a lane commit", () => {
    const store = new CellStore()
    store.setRuntime({
      projectId: "p1",
      fileId: "f1",
      username: "alice",
      requiredValidations: 1,
      auditStats: new Map(),
      lane: "es",
    })
    const current = [
      row("a", "source", "Heading"),
      row("a", "target", "Bonjour", { targetLang: "" }),
      row("a", "target", "Hola", { targetLang: "es" }),
    ]
    store.replaceRows(current, { full: true })

    // Mirrors the escaped browser race: a targeted read makes the cell fresh
    // after the delta captured its sequence, so mergeProtectedRows preserves
    // the current row set instead of accepting a possibly stale response.
    const deltaStartSeq = store.getWriteSeq()
    store.markCellFresh("a")
    const delta = mergeCellsDelta(current, ["a"], current)
    const protectedMerge = store.mergeProtectedRows(delta, deltaStartSeq)

    expect(protectedMerge.rows
      .filter((candidate) => candidate.side === "target")
      .map((candidate) => [candidate.targetLang ?? "", candidate.value]))
      .toEqual([
        ["", "Bonjour"],
        ["es", "Hola"],
      ])

    store.replaceRows(protectedMerge.rows, { full: true })
    expect(store.getCellView("a")?.translated).toBe("Hola")
    store.setRuntime({
      projectId: "p1",
      fileId: "f1",
      username: "alice",
      requiredValidations: 1,
      auditStats: new Map(),
      lane: "",
    })
    expect(store.getCellView("a")?.translated).toBe("Bonjour")
  })

  it("never paints a default-lane optimistic or queued edit onto a named lane", () => {
    const store = new CellStore()
    store.setRuntime({
      projectId: "p1",
      fileId: "f1",
      username: "alice",
      requiredValidations: 1,
      auditStats: new Map(),
      lane: "",
    })
    store.replaceRows([
      row("a", "source", "Heading"),
      row("a", "target", "Bonjour", { targetLang: "" }),
    ], { full: true })
    store.applyOptimisticTargetEdit("a", { value: "Default suggestion" })
    store.setPendingOverlay(new Map([[
      "a",
      { value: "Queued default suggestion", targetLang: "" },
    ]]))

    store.setRuntime({
      projectId: "p1",
      fileId: "f1",
      username: "alice",
      requiredValidations: 1,
      auditStats: new Map(),
      lane: "es",
    })
    expect(store.getCellView("a")?.translated).toBe("")

    store.setRuntime({
      projectId: "p1",
      fileId: "f1",
      username: "alice",
      requiredValidations: 1,
      auditStats: new Map(),
      lane: "",
    })
    expect(store.getCellView("a")?.translated).toBe("Default suggestion")
  })

  it("stamps a synthesized named-lane target and keeps it out of Project default", () => {
    const store = new CellStore()
    store.setRuntime({
      projectId: "p1",
      fileId: "f1",
      username: "alice",
      requiredValidations: 1,
      auditStats: new Map(),
      lane: "es",
    })
    store.replaceRows([
      row("a", "source", "Heading"),
      row("a", "target", "Bonjour", { targetLang: "" }),
    ], { full: true })
    store.applyOptimisticTargetEdit("a", { value: "Hola" })

    expect(store.toRows().find((candidate) => candidate.value === "Hola")?.targetLang).toBe("es")
    expect(store.getCellView("a")?.translated).toBe("Hola")

    store.setRuntime({
      projectId: "p1",
      fileId: "f1",
      username: "alice",
      requiredValidations: 1,
      auditStats: new Map(),
      lane: "",
    })
    expect(store.getCellView("a")?.translated).toBe("Bonjour")
  })

  it("clears an optimistic shadow only from the matching server lane", () => {
    const store = new CellStore()
    store.setRuntime({
      projectId: "p1",
      fileId: "f1",
      username: "alice",
      requiredValidations: 1,
      auditStats: new Map(),
      lane: "",
    })
    store.replaceRows([row("a", "source", "Heading")], { full: true })
    store.applyOptimisticTargetEdit("a", { value: "Shared text" })
    const fetchStartSeq = store.getWriteSeq()

    store.clearConfirmedShadows([
      row("a", "target", "Shared text", { targetLang: "es" }),
    ], fetchStartSeq)

    expect(store.getMemorySnapshot().optimisticEdits).toBe(1)
    expect(store.getCellView("a")?.translated).toBe("Shared text")
  })
})
