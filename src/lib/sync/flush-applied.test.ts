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
import { createFlushAppliedTracker, isStatsDerivableKind, type SentEvent } from "./flush-applied"

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

// AQU-2654. WHY: one edit is TWO events — the commit and the validation it
// casts for itself — and the socket echoes both. Measured on a 239-cell file:
// every edit read its own rows back twice and its stats twice, because the
// validate frame overwrote the commit's entry (so `confirm` saw "a different
// event" and fell back), the echo read the stats on its own, and a response
// that arrived after the echo was "ignored" as old news.
describe("createFlushAppliedTracker — one edit, commit + self-validation (AQU-2654)", () => {
  const VALIDATED = [SOURCE, { ...row("c1", "target", "En el principio", "E1"), validated: true }]
  const sentValidate = { event: { id: "V1", kind: "cell.validate", cellId: "c1" } } as unknown as SentEvent
  const sent = new Map([["V1", sentValidate]])
  const COMMIT = frame({ serverSeq: 10, rows: NEW_ROWS })
  const VALIDATE = frame({ id: "V1", kind: "cell.validate", serverSeq: 11, rows: VALIDATED })

  function setupOwn(found: SentEvent | null = sentValidate) {
    const store = makeStore([SOURCE, row("c1", "target", "old", "H")])
    const revalidateCell = vi.fn()
    const applyCommittedCellStats = vi.fn().mockReturnValue(true)
    const applyValidationCellStats = vi.fn().mockReturnValue(true)
    const revalidateCellStats = vi.fn()
    const liveApplier = createLiveApplier({ store, revalidateCell })
    const tracker = createFlushAppliedTracker({
      liveApplier,
      isActive: (p, f) => p === "p1" && f === "f1",
      applyCommittedCellStats,
      applyValidationCellStats,
      revalidateCellStats,
      lookupSentEvent: async () => found,
    })
    const echo = (f: AppliedEventFrame) => tracker.onOwnEcho(f, liveApplier.apply(f))
    return { store, revalidateCell, applyCommittedCellStats, applyValidationCellStats, revalidateCellStats, tracker, echo }
  }

  it("response carrying both frames: the commit is confirmed with no read at all", () => {
    const { revalidateCell, applyValidationCellStats, revalidateCellStats, tracker } = setupOwn()
    tracker.onFrames([COMMIT, VALIDATE], sent)
    expect(applyValidationCellStats).toHaveBeenCalledWith(sentValidate)
    expect(tracker.confirm("c1", "E1")).toEqual({ refetchCell: false, refetchStats: false })
    expect(tracker.landed(["E1"])).toBe(true)
    expect(revalidateCell).not.toHaveBeenCalled()
    expect(revalidateCellStats).not.toHaveBeenCalled()
  })

  it("echo first, response second: each event is settled once and nothing is read", async () => {
    const { applyCommittedCellStats, applyValidationCellStats, revalidateCell, revalidateCellStats, tracker, echo } = setupOwn()
    echo(COMMIT)
    echo(VALIDATE)
    await Promise.resolve()
    await Promise.resolve()
    // The response's commit frame is older than what the echo landed —
    // "ignored" by the applier, but its rows ARE in the store.
    tracker.onFrames([COMMIT, VALIDATE], sent)
    expect(tracker.confirm("c1", "E1")).toEqual({ refetchCell: false, refetchStats: false })
    expect(applyCommittedCellStats).toHaveBeenCalledTimes(1)
    expect(applyValidationCellStats).toHaveBeenCalledTimes(1)
    expect(revalidateCell).not.toHaveBeenCalled()
    expect(revalidateCellStats).not.toHaveBeenCalled()
  })

  it("response first, echo second: the echo adds nothing", async () => {
    const { applyValidationCellStats, revalidateCellStats, tracker, echo } = setupOwn()
    tracker.onFrames([COMMIT, VALIDATE], sent)
    echo(COMMIT)
    echo(VALIDATE)
    await Promise.resolve()
    await Promise.resolve()
    expect(applyValidationCellStats).toHaveBeenCalledTimes(1)
    expect(revalidateCellStats).not.toHaveBeenCalled()
  })

  it("an echoed validation whose event is nowhere to be found costs ONE stats read, not one per path", async () => {
    // Another device's write, or the record was acked before the lookup.
    const { applyValidationCellStats, revalidateCellStats, tracker, echo } = setupOwn(null)
    echo(VALIDATE)
    await Promise.resolve()
    await Promise.resolve()
    expect(revalidateCellStats).toHaveBeenCalledTimes(1)
    expect(revalidateCellStats).toHaveBeenCalledWith("c1")
    // The response for the same event arrives afterwards: already settled.
    tracker.onFrames([VALIDATE])
    expect(tracker.confirm("c1")).toEqual({ refetchCell: false, refetchStats: false })
    expect(applyValidationCellStats).not.toHaveBeenCalled()
    expect(revalidateCellStats).toHaveBeenCalledTimes(1)
  })

  it("a validation that cannot be derived keeps exactly one read between confirm and the echo", async () => {
    const { applyValidationCellStats, revalidateCellStats, tracker, echo } = setupOwn(null)
    applyValidationCellStats.mockReturnValue(false)
    tracker.onFrames([VALIDATE], sent)
    // The committing handler does the read…
    expect(tracker.confirm("c1", "V1")).toEqual({ refetchCell: false, refetchStats: true })
    // …so the echo that follows must not do it again.
    echo(VALIDATE)
    await Promise.resolve()
    await Promise.resolve()
    expect(revalidateCellStats).not.toHaveBeenCalled()
  })

  it("landed() is false for a commit no frame carried (the reconcile read stays)", () => {
    const { tracker } = setupOwn()
    tracker.onFrames([COMMIT], sent)
    expect(tracker.landed(["E1", "E-never-seen"])).toBe(false)
    tracker.onFrames([frame({ id: "E9", cell: "c1" })])
    expect(tracker.landed(["E9"])).toBe(false)
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
