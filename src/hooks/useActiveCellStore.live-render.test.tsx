// AQU-558 regression guard — "Predictions & validations don't render until
// manual refresh."
//
// Root cause of the reported regression (fixed in 5eeb695 + 9dace44): the
// editor row subscribes to the CellStore through `useCellView` →
// useSyncExternalStore. When the store's per-cell notification was dropped (an
// unstable subscribe/getSnapshot closure, or a reused version number after a
// reset), an isolated single-cell update — the optimistic AI prediction, or a
// validation-state change confirmed from the server — never reached the row.
// The bottom counters still moved (they read the store's derived progress
// directly), so the UI "lied": the value was there, the row just didn't repaint
// until a full re-render (manual reload) rebuilt every row.
//
// These tests exercise the store→row boundary that regressed: a `useCellView`
// consumer MUST reflect an optimistic target edit and an audit-stats validation
// change live, without a refetch or remount — even after an unrelated parent
// re-render (the exact window in which the unstable-closure bug dropped the
// notification).

import { describe, expect, it } from "vitest"
import { useReducer } from "react"
import { act, render, screen } from "@testing-library/react"
import type { CellRow } from "@/lib/sync/cells-read-types"
import type { CellAuditStats } from "./useCellsAuditStats"
import { CellStore, useCellView } from "./useActiveCellStore"

function row(cellId: string, side: "source" | "target", value: string, validated = false): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef: "GEN 1:1",
    anchorCellId: null,
    eventId: `${side}-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated,
    wordCount: value ? value.trim().split(/\s+/).length : 0,
    endorsementCount: validated ? 1 : 0,
  }
}

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

/** Minimal stand-in for an editor row: reads exactly what the real row reads
 *  from the store (via useCellView) and renders the fields AQU-558 is about. */
function CellProbe({ store }: { store: CellStore }) {
  const cell = useCellView(store, "c1")
  return (
    <div>
      <span data-testid="text">{cell?.translated ?? ""}</span>
      <span data-testid="status">{cell?.status ?? ""}</span>
      <span data-testid="vs">{cell?.validationStatus ?? ""}</span>
    </div>
  )
}

describe("AQU-558 — live row render on predict / validate", () => {
  it("shows an optimistic AI prediction live, without a refetch", () => {
    const store = makeStore([row("c1", "source", "In the beginning")])
    render(<CellProbe store={store} />)
    expect(screen.getByTestId("text").textContent).toBe("")
    expect(screen.getByTestId("status").textContent).toBe("empty")

    // The AI-sparkle path optimistically patches the target before the outbox
    // enqueue (ProjectWorkspace.commitCompletedCell). The subscribed row must
    // repaint immediately — this is the "prediction stays empty until refresh"
    // symptom.
    act(() => {
      store.applyOptimisticTargetEdit("c1", { value: "En el principio", aiDrafted: true })
    })

    expect(screen.getByTestId("text").textContent).toBe("En el principio")
    expect(screen.getByTestId("status").textContent).toBe("unvalidated")
  })

  it("reflects a validation-state change live when audit stats confirm it", () => {
    const store = makeStore([
      row("c1", "source", "In the beginning"),
      row("c1", "target", "En el principio"),
    ])
    render(<CellProbe store={store} />)
    expect(screen.getByTestId("vs").textContent).toBe("none")
    expect(screen.getByTestId("status").textContent).toBe("unvalidated")

    // The validation toggle emits cell.validate; the server projection is then
    // pulled back both as audit stats (revalidateCellStats → activeValidators)
    // and as the target row's `validated` flag (revalidateCell →
    // replaceRowsForCell). Both store updates must flip the subscribed row live
    // — the "validation counter moves but the row doesn't" symptom.
    act(() => {
      store.setRuntime({
        projectId: "p1",
        fileId: "f1",
        username: "me",
        requiredValidations: 1,
        auditStats: new Map([["c1", stats("c1", ["me"])]]),
      })
      store.replaceRowsForCell("c1", [
        row("c1", "source", "In the beginning"),
        row("c1", "target", "En el principio", true),
      ])
    })

    expect(screen.getByTestId("vs").textContent).toBe("full-self")
    expect(screen.getByTestId("status").textContent).toBe("validated")
  })

  // Store-level invariants behind the live render (9dace44). These catch the
  // root causes deterministically, where the React-level assertions above can't
  // (useSyncExternalStore re-reads after resubscribe, masking a torn closure in
  // a synchronous test).
  describe("store notification invariants", () => {
    it("never reuses a cell version number across reset() (monotonic counter)", () => {
      const store = makeStore([row("c1", "source", "In the beginning")])
      const v0 = store.getCellVersion("c1")
      store.applyOptimisticTargetEdit("c1", { value: "v1" })
      const v1 = store.getCellVersion("c1")
      expect(v1).toBeGreaterThan(v0)

      // A file switch resets the store. The version counter must NOT rewind —
      // a reused number lets React skip a real data change and strand the row
      // stale until remount (the reported "only a refresh fixes it").
      store.reset("p1", "f1")
      store.replaceRows([row("c1", "source", "In the beginning")], { full: true })
      store.applyOptimisticTargetEdit("c1", { value: "v2" })
      const v2 = store.getCellVersion("c1")
      expect(v2).toBeGreaterThan(v1)
    })

    it("notifies per-cell subscribers on reset()", () => {
      const store = makeStore([row("c1", "source", "In the beginning")])
      let hits = 0
      store.subscribeCell("c1", () => { hits += 1 })
      store.reset("p1", "f1")
      expect(hits).toBeGreaterThan(0)
    })

    it("emits to the cell subscriber for an optimistic edit with no source row", () => {
      // The mid-refetch / freshly-reset window: no source row exists yet, but
      // the optimistic shadow is live data. The write must still notify the
      // subscribed row (bump + emit paired) — not go silent until remount.
      const store = new CellStore()
      store.setRuntime({ projectId: "p1", fileId: "f1", username: "me", requiredValidations: 1, auditStats: new Map() })
      let hits = 0
      store.subscribeCell("c1", () => { hits += 1 })
      store.applyOptimisticTargetEdit("c1", { value: "predicted" })
      // The write must notify the subscriber (bump + emit paired). Once its
      // source row lands, the shadow overlays and the row shows "predicted".
      expect(hits).toBeGreaterThan(0)
      expect(store.getWriteSeq()).toBeGreaterThan(0)
    })

    it("emits to the changed cell when audit stats change (setRuntime)", () => {
      const store = makeStore([
        row("c1", "source", "In the beginning"),
        row("c1", "target", "En el principio"),
      ])
      let hits = 0
      store.subscribeCell("c1", () => { hits += 1 })
      store.setRuntime({
        projectId: "p1",
        fileId: "f1",
        username: "me",
        requiredValidations: 1,
        auditStats: new Map([["c1", stats("c1", ["me"])]]),
      })
      expect(hits).toBeGreaterThan(0)
    })
  })

  it("still delivers the optimistic update after an unrelated parent re-render", () => {
    // The regressed bug dropped the store notification precisely when the
    // component re-rendered between subscribe and emit (fresh useSyncExternalStore
    // closures tore down and recreated the per-cell subscription). Force a parent
    // re-render first, THEN mutate the store, and assert the row still updates.
    const store = makeStore([row("c1", "source", "In the beginning")])

    function Parent() {
      const [tick, bump] = useReducer((n: number) => n + 1, 0)
      return (
        <div>
          <button data-testid="bump" onClick={bump}>bump {tick}</button>
          <CellProbe store={store} />
        </div>
      )
    }

    render(<Parent />)
    act(() => {
      screen.getByTestId("bump").click()
    })
    act(() => {
      store.applyOptimisticTargetEdit("c1", { value: "En el principio", aiDrafted: true })
    })

    expect(screen.getByTestId("text").textContent).toBe("En el principio")
  })
})
