// AQU-2655 — a frame without rows is refetched once per event.
//
// WHY: this tab's own write reaches the applier twice, in the POST response
// and as its socket echo. A `cell.audio.*` frame carries no rows, so each copy
// used to read the cell back: two `GET …/cells` for one recording or one
// transcript save. Both copies arrive after the projection, so the second
// read can only repeat the first. A DIFFERENT event on the same cell must
// still be read, and a frame with rows must still land through the applier.

import { describe, expect, it, vi } from "vitest"
import { CellStore } from "@/hooks/useActiveCellStore"
import { createLiveApplier, type AppliedEventFrame } from "./live-apply"
import { refetchOncePerEvent } from "./refetch-once-per-event"

function frame(over: Partial<AppliedEventFrame>): AppliedEventFrame {
  return {
    t: "event.applied",
    id: "e1",
    kind: "cell.audio.attach",
    project: "p1",
    file: "f1",
    cell: "c1",
    by: "me",
    ...over,
  } as AppliedEventFrame
}

function setup() {
  const store = new CellStore()
  store.setRuntime({ projectId: "p1", fileId: "f1", username: "me", requiredValidations: 1, auditStats: new Map() })
  const revalidateCell = vi.fn()
  const applier = refetchOncePerEvent(createLiveApplier({ store, revalidateCell }))
  return { applier, revalidateCell }
}

describe("refetchOncePerEvent (AQU-2655)", () => {
  it("reads the cell once for the POST copy and the echo of one row-less event", () => {
    const { applier, revalidateCell } = setup()
    expect(applier.apply(frame({}))).toBe("refetch") // POST /events applied[]
    expect(applier.apply(frame({}))).toBe("refetch") // the socket echo
    expect(revalidateCell).toHaveBeenCalledTimes(1)
    expect(revalidateCell).toHaveBeenCalledWith("c1")
  })

  it("still reads the cell for a different event on it", () => {
    const { applier, revalidateCell } = setup()
    applier.apply(frame({ id: "e1" }))
    applier.apply(frame({ id: "e2", kind: "cell.audio.select" }))
    expect(revalidateCell).toHaveBeenCalledTimes(2)
  })

  it("forgets on reset (file switch), so the same id is read again", () => {
    const { applier, revalidateCell } = setup()
    applier.apply(frame({}))
    applier.reset()
    applier.apply(frame({}))
    expect(revalidateCell).toHaveBeenCalledTimes(2)
  })

  it("leaves frames that carry rows to the applier", () => {
    const { applier, revalidateCell } = setup()
    const withRows = frame({ kind: "target.cell.commit", rows: [], serverSeq: 5 })
    expect(applier.apply(withRows)).toBe("applied")
    expect(applier.apply(withRows)).toBe("applied")
    expect(revalidateCell).not.toHaveBeenCalled()
  })
})
