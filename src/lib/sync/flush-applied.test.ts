// Own-write landing from the POST /events response.
//
// WHY: a commit used to cost the POST plus two confirming GETs (by-ids row,
// audit-stats). The response now carries the projected frame, so the
// committing handler must be able to skip both — but only when the server
// really landed THIS event; anything else keeps the fallback GETs, otherwise
// the next commit chains on a stale parent and is refused as bumped.

import { describe, expect, it, vi } from "vitest"
import type { CellRow } from "./cells-read-types"
import { CellStore } from "@/hooks/useActiveCellStore"
import { createLiveApplier, type AppliedEventFrame } from "./live-apply"
import { confirmCommittedBatch, createFlushAppliedTracker, isStatsDerivableKind } from "./flush-applied"

function row(cellId: string, side: "source" | "target", value: string, eventId: string): CellRow {
  return {
    cellId, side, value, valueHtml: null, type: null, canonicalRef: "GEN 1:1",
    anchorCellId: null, eventId, sourceEventId: null, lastEditor: "alice",
    lastEditAt: 1, validated: false, wordCount: 1,
  }
}

function makeStore(rows: CellRow[]): CellStore {
  const store = new CellStore()
  store.setRuntime({ projectId: "p1", fileId: "f1", username: "me", requiredValidations: 1, auditStats: new Map() })
  store.replaceRows(rows, { full: true })
  return store
}

function frame(over: Partial<AppliedEventFrame>): AppliedEventFrame {
  return { t: "event.applied", id: "E1", kind: "target.cell.commit", project: "p1", file: "f1", cell: "c1", by: "me", ...over }
}

const SOURCE = row("c1", "source", "In the beginning", "S0")
const NEW_ROWS = [SOURCE, row("c1", "target", "En el principio", "E1")]

function setup(rows: CellRow[] = [SOURCE, row("c1", "target", "old", "H")]) {
  const store = makeStore(rows)
  const revalidateCell = vi.fn()
  const applyCommittedCellStats = vi.fn().mockReturnValue(true)
  const tracker = createFlushAppliedTracker({
    liveApplier: createLiveApplier({ store, revalidateCell }),
    isActive: (p, f) => p === "p1" && f === "f1",
    applyCommittedCellStats,
  })
  return { store, revalidateCell, applyCommittedCellStats, tracker }
}

describe("createFlushAppliedTracker", () => {
  it("lands the frame's rows + derived stats, then confirm() needs NO refetch", () => {
    const { store, revalidateCell, applyCommittedCellStats, tracker } = setup()
    tracker.onFrames([frame({ serverSeq: 10, rows: NEW_ROWS })])

    expect(store.getCellView("c1")?.targetEventId).toBe("E1")
    expect(applyCommittedCellStats).toHaveBeenCalledWith("c1", NEW_ROWS)
    expect(revalidateCell).not.toHaveBeenCalled()
    expect(tracker.confirm("c1", "E1")).toEqual({ refetchCell: false, refetchStats: false })
    // Consumed — a second confirm for the same cell falls back.
    expect(tracker.confirm("c1", "E1")).toEqual({ refetchCell: true, refetchStats: true })
  })

  it("confirm() without a known eventId trusts whatever the flush landed", () => {
    const { tracker } = setup()
    tracker.onFrames([frame({ serverSeq: 10, rows: NEW_ROWS })])
    expect(tracker.confirm("c1")).toEqual({ refetchCell: false, refetchStats: false })
  })

  it("keeps both refetches when the server landed a DIFFERENT event for the cell", () => {
    const { tracker } = setup()
    tracker.onFrames([frame({ id: "E0", serverSeq: 9, rows: [SOURCE, row("c1", "target", "x", "E0")] })])
    expect(tracker.confirm("c1", "E1")).toEqual({ refetchCell: true, refetchStats: true })
  })

  it("keeps both refetches when the response carried no rows (older server / >cap batch)", () => {
    const { revalidateCell, tracker } = setup()
    tracker.onFrames([frame({})])
    // liveApplier already kicked the row refetch for the legacy frame.
    expect(revalidateCell).toHaveBeenCalledWith("c1")
    expect(tracker.confirm("c1", "E1")).toEqual({ refetchCell: true, refetchStats: true })
  })

  it("lands rows but still refetches stats for a validate (validators aren't on the row)", () => {
    const { applyCommittedCellStats, tracker } = setup()
    const validated = [SOURCE, { ...row("c1", "target", "old", "H"), validated: true }]
    tracker.onFrames([frame({ id: "V1", kind: "cell.validate", serverSeq: 11, rows: validated })])
    expect(applyCommittedCellStats).not.toHaveBeenCalled()
    expect(tracker.confirm("c1", "V1")).toEqual({ refetchCell: false, refetchStats: true })
  })

  it("keeps the stats refetch when the stats hook could not merge (disabled / other file)", () => {
    const { applyCommittedCellStats, tracker } = setup()
    applyCommittedCellStats.mockReturnValue(false)
    tracker.onFrames([frame({ serverSeq: 10, rows: NEW_ROWS })])
    expect(tracker.confirm("c1", "E1")).toEqual({ refetchCell: false, refetchStats: true })
  })

  it("ignores frames for a file/project that is not mounted", () => {
    const { store, tracker } = setup()
    tracker.onFrames([frame({ file: "f2", serverSeq: 10, rows: NEW_ROWS })])
    expect(store.getCellView("c1")?.targetEventId).toBe("H")
    expect(tracker.confirm("c1", "E1")).toEqual({ refetchCell: true, refetchStats: true })
  })

  it("reset() forgets landed cells (file switch)", () => {
    const { tracker } = setup()
    tracker.onFrames([frame({ serverSeq: 10, rows: NEW_ROWS })])
    tracker.reset()
    expect(tracker.confirm("c1", "E1")).toEqual({ refetchCell: true, refetchStats: true })
  })
})

// AQU-2654: a batch-drafted chunk is ten commits in one POST. It must cost no
// confirming read when the response carried all ten, and at most ONE of each
// when it did not — never a pair of file-level GETs per chunk regardless.
describe("confirmCommittedBatch", () => {
  const CELLS = ["c1", "c2", "c3"]
  const sources = CELLS.map((id) => row(id, "source", `source ${id}`, `S-${id}`))
  const landedFrame = (id: string) => frame({
    id: `E-${id}`, cell: id, serverSeq: 10,
    rows: [row(id, "source", `source ${id}`, `S-${id}`), row(id, "target", `draft ${id}`, `E-${id}`)],
  })

  it("needs NO read when the response landed every draft of the chunk", () => {
    const { tracker, store } = setup(sources)
    tracker.onFrames(CELLS.map(landedFrame))

    expect(confirmCommittedBatch(
      tracker,
      CELLS.map((cellId) => ({ cellId, eventId: `E-${cellId}`, saved: true })),
    )).toEqual({ refetchCell: false, refetchStats: false })
    for (const id of CELLS) expect(store.getCellView(id)?.targetEventId).toBe(`E-${id}`)
  })

  it("asks for each read once when one draft's frame is missing", () => {
    const { tracker } = setup(sources)
    tracker.onFrames([landedFrame("c1"), landedFrame("c3")])

    expect(confirmCommittedBatch(
      tracker,
      CELLS.map((cellId) => ({ cellId, eventId: `E-${cellId}`, saved: true })),
    )).toEqual({ refetchCell: true, refetchStats: true })
  })

  it("asks for both reads when a draft was refused, even though the rest landed", () => {
    const { tracker } = setup(sources)
    tracker.onFrames([landedFrame("c1"), landedFrame("c2")])

    expect(confirmCommittedBatch(tracker, [
      { cellId: "c1", eventId: "E-c1", saved: true },
      { cellId: "c2", eventId: "E-c2", saved: true },
      { cellId: "c3", eventId: "E-c3", saved: false },
    ])).toEqual({ refetchCell: true, refetchStats: true })
  })

  it("trusts the landed frame for a draft whose event id the caller no longer holds", () => {
    const { tracker } = setup(sources)
    tracker.onFrames(CELLS.map(landedFrame))

    expect(confirmCommittedBatch(
      tracker,
      CELLS.map((cellId) => ({ cellId, saved: true })),
    )).toEqual({ refetchCell: false, refetchStats: false })
  })

  it("consumes every entry, so a later commit of the same cell is not matched against this chunk", () => {
    const { tracker } = setup(sources)
    tracker.onFrames(CELLS.map(landedFrame))
    confirmCommittedBatch(tracker, CELLS.map((cellId) => ({ cellId, eventId: `E-${cellId}`, saved: true })))

    expect(tracker.confirm("c1", "E-c1")).toEqual({ refetchCell: true, refetchStats: true })
  })
})

describe("isStatsDerivableKind", () => {
  it("content commits/creates derive; validation and everything else do not", () => {
    expect(isStatsDerivableKind("target.cell.commit")).toBe(true)
    expect(isStatsDerivableKind("source.cell.create")).toBe(true)
    expect(isStatsDerivableKind("cell.validate")).toBe(false)
    expect(isStatsDerivableKind("cell.unvalidate")).toBe(false)
    expect(isStatsDerivableKind("target.cell.delete")).toBe(false)
  })
})
