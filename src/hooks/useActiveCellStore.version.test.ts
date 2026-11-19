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
import { describe, expect, it, vi } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { mergeCellsDelta } from "@/lib/sync/cells-cache"
import type { CellAuditStats } from "./useCellsAuditStats"
import { CellStore, WHOLE_FILE_NOTIFY_MS, subscribeAllCoalesced } from "./useActiveCellStore"

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
  it("does not publish identical complete rows, but publishes changes in every lane", () => {
    const store = new CellStore()
    runtime(store, new Map())
    const source = row("a", "source", "Hello", { metadata: { nested: [1, { label: "section" }] } })
    let target = row("a", "target", "Default")
    let spanish = row("a", "target", "Hola", { targetLang: "es" })
    store.replaceRows([source, target, spanish])
    const summary = store.getCellSummary("a")
    const allVersion = store.getAllVersion()
    const cellVersion = store.getCellVersion("a")
    let notifications = 0
    store.subscribeAll(() => { notifications++ })
    store.replaceRowsForCell("a", structuredClone([source, target, spanish]))
    expect(notifications).toBe(0)
    expect(store.getAllVersion()).toBe(allVersion)
    expect(store.getCellVersion("a")).toBe(cellVersion)
    expect(store.getCellSummary("a")).toBe(summary)
    for (const patch of [
      { eventId: "new-head" }, { validated: true }, { endorsementCount: 2 },
      { valueHtml: "<b>Default</b>" }, { metadata: { nested: [2] } },
      { lastEditor: "bob" }, { sourceEventId: "new-source" },
    ]) {
      target = { ...target, ...patch }
      const before = notifications
      store.replaceRowsForCell("a", [source, target, spanish])
      expect(notifications).toBe(before + 1)
    }
    spanish = { ...spanish, value: "Buenos días" }
    const before = notifications
    store.replaceRowsForCell("a", [source, target, spanish])
    expect(notifications).toBe(before + 1)
    expect(store.toRows()).toContainEqual(spanish)
    store.replaceRowsForCell("a", [source, target])
    expect(store.toRows().some(row => row.targetLang === "es")).toBe(false)
    store.replaceRowsForCell("a", [])
    expect(store.getCellView("a")).toBeNull()
  })

  it("publishes shadow removal even when the subsequent row response is identical", () => {
    const store = new CellStore()
    runtime(store, new Map())
    store.replaceRows([row("a", "source", "Hello"), row("a", "target", "Draft")])
    store.applyOptimisticTargetEdit("a", { value: "Saved" })
    store.setPendingOverlay(new Map([["a", { value: "", targetLang: "" }]]))
    const version = store.getAllVersion()
    const rows = store.toRows()
    let notifications = 0
    store.subscribeAll(() => { notifications++ })
    store.clearConfirmedShadows(rows, store.getWriteSeq())
    const confirmedVersion = store.getAllVersion()
    expect(confirmedVersion).toBeGreaterThan(version)
    expect(store.getCellSummary("a")?.translated).toBe("")
    expect(notifications).toBe(1)
    store.replaceRowsForCell("a", structuredClone(rows))
    expect(store.getAllVersion()).toBe(confirmedVersion)
    expect(notifications).toBe(1)
  })

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

  it("applies a model response as one version bump and retains AI provenance", () => {
    const store = new CellStore()
    runtime(store, new Map())
    store.replaceRows([
      row("a", "source", "hello"),
      row("b", "source", "world"),
      row("c", "source", "untouched"),
    ])
    const beforeFile = store.getAllVersion()
    const beforeA = store.getCellVersion("a")
    const beforeB = store.getCellVersion("b")
    const beforeC = store.getCellVersion("c")
    let fileNotifications = 0
    let aNotifications = 0
    let bNotifications = 0
    store.subscribeAll(() => { fileNotifications++ })
    store.subscribeCell("a", () => { aNotifications++ })
    store.subscribeCell("b", () => { bNotifications++ })
    const provenance = {
      model: "test-model",
      provider: "custom" as const,
      promptVersion: "v1",
      exampleIds: [],
      generatedAt: 123,
      mode: "batch" as const,
      projectState: {
        sourceLanguage: "en",
        targetLanguage: "es",
        approvedExampleCount: 0,
      },
    }

    store.setPendingState(new Map([
      ["a", {
        value: "hola",
        eventId: "event-a",
        aiDrafted: true,
        aiDraft: provenance,
      }],
      ["b", {
        value: "mundo",
        eventId: "event-b",
        aiDrafted: true,
        aiDraft: provenance,
      }],
    ]), ["event-a", "event-b"])

    expect(store.getAllVersion()).toBe(beforeFile + 1)
    expect(fileNotifications).toBe(1)
    expect(store.getCellVersion("a")).toBeGreaterThan(beforeA)
    expect(store.getCellVersion("b")).toBeGreaterThan(beforeB)
    expect(store.getCellVersion("c")).toBe(beforeC)
    expect(aNotifications).toBe(1)
    expect(bNotifications).toBe(1)
    expect(store.getCellView("a")?.aiDrafted).toBe(true)
    expect(store.getCellView("a")?.aiDraft).toEqual(provenance)
    expect(store.getCellView("b")?.translated).toBe("mundo")
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

// AQU-2654. WHY: one applied frame is three store mutations, one commit five
// or six, and each announced itself — a full pass over every subscriber, and
// for the workspace (which subscribes to the whole file) a full render, per
// mutation. Measured: 15 workspace renders for one committed cell.
describe("CellStore announcements (AQU-2654)", () => {
  function loaded(): CellStore {
    const store = new CellStore()
    runtime(store, new Map())
    store.replaceRows([row("a", "source", "Hello"), row("a", "target", "old"), row("b", "source", "World")])
    return store
  }

  it("mutations inside one batch are announced once, with every cell that changed", () => {
    const store = loaded()
    let all = 0
    let list = 0
    let cellA = 0
    let cellB = 0
    store.subscribeAll(() => { all++ })
    store.subscribeList(() => { list++ })
    store.subscribeCell("a", () => { cellA++ })
    store.subscribeCell("b", () => { cellB++ })

    store.batch(() => {
      store.applyOptimisticTargetEdit("a", { value: "new" })
      // Reads inside the batch see each step: only the telling waits.
      expect(store.getCellView("a")?.translated).toBe("new")
      store.clearConfirmedShadows([row("a", "target", "new", { eventId: "E1" })], store.getWriteSeq())
      store.replaceRowsForCell("a", [row("a", "source", "Hello"), row("a", "target", "new", { eventId: "E1" })])
      store.applyOptimisticTargetEdit("b", { value: "second" })
      expect(all).toBe(0)
      expect(cellA).toBe(0)
    })

    expect(all).toBe(1)
    expect(list).toBe(1)
    expect(cellA).toBe(1)
    expect(cellB).toBe(1)
    expect(store.getCellView("a")?.targetEventId).toBe("E1")
  })

  it("a nested batch announces when the OUTERMOST one ends, and a throwing batch still announces", () => {
    const store = loaded()
    let all = 0
    store.subscribeAll(() => { all++ })
    store.batch(() => {
      store.batch(() => store.applyOptimisticTargetEdit("a", { value: "one" }))
      expect(all).toBe(0)
      store.applyOptimisticTargetEdit("a", { value: "two" })
    })
    expect(all).toBe(1)
    expect(() => store.batch(() => {
      store.applyOptimisticTargetEdit("a", { value: "three" })
      throw new Error("boom")
    })).toThrow("boom")
    // The mutation happened, so subscribers must hear of it.
    expect(all).toBe(2)
    store.applyOptimisticTargetEdit("a", { value: "four" })
    expect(all).toBe(3)
  })

  it("a whole-file subscriber is told once for a burst, while the row is told at once", () => {
    vi.useFakeTimers()
    try {
      const store = loaded()
      let wholeFile = 0
      let rowA = 0
      const unsubscribe = subscribeAllCoalesced(store, () => { wholeFile++ })
      store.subscribeCell("a", () => { rowA++ })
      const before = store.getAllVersion()
      store.applyOptimisticTargetEdit("a", { value: "one" })
      store.applyOptimisticTargetEdit("a", { value: "two" })
      store.applyOptimisticTargetEdit("a", { value: "three" })
      // The row's own subscription is synchronous: the edit shows immediately.
      expect(rowA).toBe(3)
      // The snapshot is live — a render that happens meanwhile reads it…
      expect(store.getAllVersion()).toBeGreaterThan(before)
      // …and the whole-file wake-up is one, a couple of frames later.
      expect(wholeFile).toBe(0)
      vi.advanceTimersByTime(WHOLE_FILE_NOTIFY_MS)
      expect(wholeFile).toBe(1)
      store.applyOptimisticTargetEdit("a", { value: "four" })
      unsubscribe()
      vi.advanceTimersByTime(WHOLE_FILE_NOTIFY_MS)
      expect(wholeFile).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
