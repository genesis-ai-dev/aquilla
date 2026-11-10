// AQU-2432 (review, Nov 9): recording a line that was empty never brings back
// an overlap nobody asked for. The take after it may still hold a pull-back
// that read as none while the line was empty; the recording clears it, and it
// is part of the recording's own step: one Undo takes the take away AND puts
// that place back, one Redo does both again.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { historyReady, redoLast, registerStepKinds, resetHistoryForTests, setHistoryScope, undoLast } from "./history"
import { clearHistoryStoreForTests } from "./history-store"
import { recordTakeAdded, setTakeAddedHeals, takeStepHandlers, type TakeStepContext } from "./take-steps"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"

type Takes = Record<string, Record<string, Partial<CodexCellAttachment>>>

/** Line b gets a new take; line c's take holds a stale 1 s pull-back. */
function world() {
  const takes: Takes = {
    b: { newB: { slot: "recording" } },
    c: { takeC: { slot: "recording", targetOffsetMs: 250, recordingsOffsetMs: -1_000 } },
  }
  const playing: Record<string, string | null> = { b: "newB" }
  const ctx: TakeStepContext = {
    readTake: (cellId, id) => {
      const att = takes[cellId]?.[id]
      return att && !att.isDeleted ? (att as CodexCellAttachment) : null
    },
    selectedIn: (cellId) => playing[cellId] ?? null,
    applyTrim: vi.fn(async () => {}),
    applyPlace: vi.fn(async (cellId, id, place) => {
      takes[cellId][id] = { ...takes[cellId][id], targetOffsetMs: place.targetOffsetMs, recordingsOffsetMs: place.recordingsOffsetMs }
    }),
    cut: vi.fn(async () => true),
    uncut: vi.fn(async () => {}),
    newPieceId: () => "fresh",
    select: vi.fn(async (cellId, _slot, id) => {
      if (id) takes[cellId][id] = { ...takes[cellId][id], isDeleted: false }
      playing[cellId] = id
    }),
    remove: vi.fn(async (cellId, id) => {
      takes[cellId][id] = { ...takes[cellId][id], isDeleted: true }
      if (playing[cellId] === id) playing[cellId] = null
    }),
    rename: vi.fn(async () => {}),
  }
  return { takes, ctx }
}

beforeEach(async () => {
  resetHistoryForTests()
  await clearHistoryStoreForTests()
  setHistoryScope("p1", "sam")
  await historyReady()
  setTakeAddedHeals(null)
})

describe("recording an empty line clears the next take's old pull-back, in the recording's step (AQU-2432)", () => {
  it("the workspace's answer rides the step: Undo puts the pull-back back with the take gone, Redo clears it again", async () => {
    const { takes, ctx } = world()
    registerStepKinds(takeStepHandlers(ctx))
    // What the workspace does: clear it now, and say what it cleared.
    const heal = vi.fn(() => {
      takes.c.takeC = { ...takes.c.takeC, recordingsOffsetMs: 0 }
      return [{ cellId: "c", audioId: "takeC", before: 250, after: 250, recordingsBefore: -1_000, recordingsAfter: 0 }]
    })
    setTakeAddedHeals(heal)
    recordTakeAdded("record", { cellId: "b", audioId: "newB", slot: "recording", selectedBefore: null }, { fileId: "f1" })
    expect(heal).toHaveBeenCalledWith({ cellId: "b", audioId: "newB", slot: "recording", selectedBefore: null }, { fileId: "f1" })

    expect((await undoLast())?.outcome).toEqual({ kind: "done" })
    expect(takes.b.newB.isDeleted).toBe(true)
    expect(takes.c.takeC).toMatchObject({ targetOffsetMs: 250, recordingsOffsetMs: -1_000 })

    expect((await redoLast())?.outcome).toEqual({ kind: "done" })
    expect(takes.b.newB.isDeleted).toBe(false)
    expect(takes.c.takeC).toMatchObject({ targetOffsetMs: 250, recordingsOffsetMs: 0 })
  })

  it("a take moved since is someone's work: Undo leaves its place alone and still takes the recording away", async () => {
    const { takes, ctx } = world()
    registerStepKinds(takeStepHandlers(ctx))
    setTakeAddedHeals(() => {
      takes.c.takeC = { ...takes.c.takeC, recordingsOffsetMs: 0 }
      return [{ cellId: "c", audioId: "takeC", before: 250, after: 250, recordingsBefore: -1_000, recordingsAfter: 0 }]
    })
    recordTakeAdded("record", { cellId: "b", audioId: "newB", slot: "recording", selectedBefore: null }, { fileId: "f1" })
    takes.c.takeC = { ...takes.c.takeC, recordingsOffsetMs: 700 } // someone dragged it since
    expect((await undoLast())?.outcome).toEqual({ kind: "done" })
    expect(takes.b.newB.isDeleted).toBe(true)
    expect(takes.c.takeC.recordingsOffsetMs).toBe(700)
  })

  it("with nothing to clear the step is the recording alone, exactly as before", async () => {
    const { takes, ctx } = world()
    registerStepKinds(takeStepHandlers(ctx))
    setTakeAddedHeals(() => [])
    recordTakeAdded("record", { cellId: "b", audioId: "newB", slot: "recording", selectedBefore: null }, { fileId: "f1" })
    expect((await undoLast())?.outcome).toEqual({ kind: "done" })
    expect(ctx.applyPlace).not.toHaveBeenCalled()
    expect(takes.c.takeC.recordingsOffsetMs).toBe(-1_000)
  })
})
