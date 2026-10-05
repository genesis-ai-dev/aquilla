// AQU-1571: the live store carries who wrote each line's current text in the
// ACTIVE lane, so the validation control can grey a vote the server would
// refuse under "Allow self-validation" off. The block must start the moment
// the viewer edits — before the edit reaches the server — and must never be
// set by a revert or borrowed from another lane.
import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "./useActiveCellStore"

function row(cellId: string, side: "source" | "target", value: string, over: Partial<CellRow> = {}): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `${side}-${cellId}-${over.targetLang ?? ""}`,
    sourceEventId: null,
    lastEditor: "src-author",
    lastEditAt: 1,
    validated: false,
    wordCount: value ? 1 : 0,
    endorsementCount: 0,
    ...over,
  }
}

function store(lane = "", username = "dev"): CellStore {
  const s = new CellStore()
  s.setRuntime({ projectId: "p1", fileId: "f1", username, requiredValidations: 1, auditStats: new Map(), lane })
  s.replaceRows([
    row("a", "source", "hello"),
    row("a", "target", "hallo", { lastEditor: "ana" }),
    row("a", "target", "hola", { targetLang: "es", lastEditor: "dev" }),
    row("b", "source", "world"),
  ])
  return s
}

describe("CellStore lastEditor (AQU-1571)", () => {
  it("carries the active lane's target editor on the view and the summary", () => {
    const s = store()
    expect(s.getCellView("a")?.lastEditor).toBe("ana")
    expect(s.getCellSummary("a")?.lastEditor).toBe("ana")
  })

  it("follows the lane, never borrowing another lane's editor", () => {
    const s = store("es")
    expect(s.getCellView("a")?.lastEditor).toBe("dev")
    expect(s.getCellSummary("a")?.lastEditor).toBe("dev")
  })

  // The source row's editor wrote the SOURCE; a line with no target text has
  // nothing anyone could validate, and must not read as somebody's edit.
  it("is null on a line with no target row, never the source row's editor", () => {
    const s = store()
    expect(s.getCellView("b")?.lastEditor).toBeNull()
    expect(s.getCellSummary("b")?.lastEditor).toBeNull()
  })

  it("stamps the viewer the moment they change the text", () => {
    const s = store()
    s.applyOptimisticTargetEdit("a", { value: "hallo welt" })
    expect(s.getCellView("a")?.lastEditor).toBe("dev")
    expect(s.getCellSummary("a")?.lastEditor).toBe("dev")
  })

  it("stamps the viewer on a line they fill for the first time", () => {
    const s = store()
    s.applyOptimisticTargetEdit("b", { value: "Welt" })
    expect(s.getCellView("b")?.lastEditor).toBe("dev")
  })

  it("stamps through the bulk edit path too", () => {
    const s = store()
    s.applyOptimisticTargetEdits([{ cellId: "a", value: "neu" }, { cellId: "b", value: "auch" }])
    expect(s.getCellView("a")?.lastEditor).toBe("dev")
    expect(s.getCellView("b")?.lastEditor).toBe("dev")
  })

  // A failed enqueue writes the confirmed text back through the same path.
  // That revert must hand the line back to its real editor, or the viewer
  // would be blocked from validating somebody else's work.
  it("hands the line back to its real editor when an edit is reverted", () => {
    const s = store()
    s.applyOptimisticTargetEdit("a", { value: "hallo welt" })
    s.applyOptimisticTargetEdit("a", { value: "hallo" })
    expect(s.getCellView("a")?.lastEditor).toBe("ana")
    expect(s.getCellSummary("a")?.lastEditor).toBe("ana")
  })

  it("does not stamp an edit that writes the confirmed text unchanged", () => {
    const s = store()
    s.applyOptimisticTargetEdit("a", { value: "hallo" })
    expect(s.getCellView("a")?.lastEditor).toBe("ana")
  })

  // A queued commit of the viewer's is theirs on the server once it lands,
  // so typing back to the original text still leaves the line theirs.
  it("keeps the viewer while a commit of theirs is queued, even back at the original text", () => {
    const s = store()
    s.applyOptimisticTargetEdit("a", { value: "hallo welt" })
    s.setPendingOverlay(new Map([["a", { value: "hallo welt", eventId: "e1", targetLang: "" }]]))
    s.applyOptimisticTargetEdit("a", { value: "hallo" })
    expect(s.getCellView("a")?.lastEditor).toBe("dev")
  })

  // After a reload the outbox still holds the viewer's unsynced commit: the
  // server row says Ana, the pending overlay says the line is now the viewer's.
  it("stamps the viewer while a pending overlay of theirs is shown", () => {
    const s = store()
    s.setPendingOverlay(new Map([["a", { value: "hallo welt", eventId: "e1", targetLang: "" }]]))
    expect(s.getCellView("a")?.lastEditor).toBe("dev")
    expect(s.getCellSummary("a")?.lastEditor).toBe("dev")
  })

  it("ignores a pending overlay from another lane", () => {
    const s = store()
    s.setPendingOverlay(new Map([["a", { value: "hola mundo", eventId: "e1", targetLang: "es" }]]))
    expect(s.getCellView("a")?.lastEditor).toBe("ana")
  })

  // The server confirms the edit (the shadow is dropped) a moment before the
  // refetched row, which says the same, is installed. The line must not flip
  // back to clickable in between.
  it("keeps the stamp once the confirmed edit's shadow is cleared", () => {
    const s = store()
    s.applyOptimisticTargetEdit("a", { value: "hallo welt" })
    s.clearConfirmedShadows([row("a", "target", "hallo welt", { lastEditor: "dev" })], Number.MAX_SAFE_INTEGER)
    expect(s.hasOptimisticEdits()).toBe(false)
    expect(s.getCellView("a")?.lastEditor).toBe("dev")
  })

  it("takes the server's answer from a fresh row once no edit is in flight", () => {
    const s = store()
    s.replaceRows([
      row("a", "source", "hello"),
      row("a", "target", "hallo welt", { lastEditor: "bo" }),
      row("b", "source", "world"),
    ], { full: true })
    expect(s.getCellView("a")?.lastEditor).toBe("bo")
  })
})
