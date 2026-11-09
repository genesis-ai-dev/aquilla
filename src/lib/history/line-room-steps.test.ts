// AQU-2432 (Sam, Nov 9, rule 7): undo and redo of a drag that changed the
// room of the unrecorded lines before a take — every room it changed, and the
// take's own place when the drag changed that too, as ONE step.
import { describe, it, expect, vi } from "vitest"
import { lineRoomStepHandlers, type LineRoomStepContext, type LineRoomStepData } from "./line-room-steps"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { StepHandler } from "./history"

type Rooms = Record<string, number | null>
type Takes = Record<string, Partial<CodexCellAttachment>>

function ctxFor(rooms: Rooms, takes: Takes = {}) {
  const ctx: LineRoomStepContext = {
    readRoom: (cellId) => (cellId in rooms ? rooms[cellId] : undefined),
    applyRooms: vi.fn(async (changes) => {
      for (const c of changes) rooms[c.cellId] = c.roomMs
    }),
    readTake: (_c, id) => (takes[id] ? (takes[id] as CodexCellAttachment) : null),
    applyPlace: vi.fn(async (_c, id, place) => {
      takes[id] = { ...takes[id], targetOffsetMs: place.targetOffsetMs, recordingsOffsetMs: place.recordingsOffsetMs }
    }),
  }
  return { ctx, step: lineRoomStepHandlers(ctx)["line.room"] as StepHandler<LineRoomStepData> }
}

/** The drag closed line c's room to nothing and line b's from natural to 2 s. */
const twoLines: LineRoomStepData = {
  rooms: [{ cellId: "c", before: null, after: 0 }, { cellId: "b", before: null, after: 2_000 }],
}

describe("line.room (AQU-2432)", () => {
  it("undo gives every line its room back in one step, and redo closes them again", async () => {
    const rooms: Rooms = { b: 2_000, c: 0 }
    const { ctx, step } = ctxFor(rooms)
    expect(await step.undo(twoLines)).toEqual({ kind: "done" })
    expect(ctx.applyRooms).toHaveBeenCalledTimes(1)
    expect(ctx.applyRooms).toHaveBeenCalledWith([{ cellId: "c", roomMs: null }, { cellId: "b", roomMs: null }])
    expect(rooms).toEqual({ b: null, c: null })
    expect(await step.redo(twoLines)).toEqual({ kind: "done" })
    expect(rooms).toEqual({ b: 2_000, c: 0 })
    expect(ctx.applyPlace).not.toHaveBeenCalled()
  })

  it("is skipped as changed once someone has changed one of the rooms since, and changes nothing", async () => {
    const rooms: Rooms = { b: 500, c: 0 }
    const { ctx, step } = ctxFor(rooms)
    expect(await step.undo(twoLines)).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.applyRooms).not.toHaveBeenCalled()
    expect(rooms).toEqual({ b: 500, c: 0 })
  })

  it("is skipped as gone when one of the lines no longer exists", async () => {
    const { ctx, step } = ctxFor({ c: 0 })
    expect(await step.undo(twoLines)).toEqual({ kind: "skipped", reason: "gone" })
    expect(ctx.applyRooms).not.toHaveBeenCalled()
  })

  it("a room of 0 and no stored room are different things", async () => {
    const closed: LineRoomStepData = { rooms: [{ cellId: "b", before: 0, after: null }] }
    const { step } = ctxFor({ b: 0 })
    // The step left it at natural (null); it is at 0, so someone changed it.
    expect(await step.undo(closed)).toEqual({ kind: "skipped", reason: "changed" })
    expect(await step.redo(closed)).toEqual({ kind: "done" })
  })

  describe("a drag that changed the take's own place too", () => {
    /** Dragged later: line b's room came back, and the rest became the take's pause. */
    const withTake: LineRoomStepData = {
      rooms: [{ cellId: "b", before: 1_000, after: null }],
      take: { cellId: "c", audioId: "a", before: 0, after: 2_000, recordingsBefore: null, recordingsAfter: 2_000 },
    }

    it("undo puts the room and the take's place back together; redo moves both again", async () => {
      const rooms: Rooms = { b: null }
      const takes: Takes = { a: { targetOffsetMs: 2_000, recordingsOffsetMs: 2_000 } }
      const { ctx, step } = ctxFor(rooms, takes)
      expect(await step.undo(withTake)).toEqual({ kind: "done" })
      expect(rooms).toEqual({ b: 1_000 })
      expect(ctx.applyPlace).toHaveBeenCalledWith("c", "a", { targetOffsetMs: 0, recordingsOffsetMs: null })
      expect(await step.redo(withTake)).toEqual({ kind: "done" })
      expect(rooms).toEqual({ b: null })
      expect(takes.a).toMatchObject({ targetOffsetMs: 2_000, recordingsOffsetMs: 2_000 })
    })

    it("is skipped as changed when the take was moved since: neither the room nor the take is touched", async () => {
      const rooms: Rooms = { b: null }
      const { ctx, step } = ctxFor(rooms, { a: { targetOffsetMs: 2_000, recordingsOffsetMs: 3_500 } })
      expect(await step.undo(withTake)).toEqual({ kind: "skipped", reason: "changed" })
      expect(ctx.applyRooms).not.toHaveBeenCalled()
      expect(ctx.applyPlace).not.toHaveBeenCalled()
    })

    it("is skipped as gone when the take was deleted since", async () => {
      const { ctx, step } = ctxFor({ b: null }, {})
      expect(await step.undo(withTake)).toEqual({ kind: "skipped", reason: "gone" })
      expect(ctx.applyRooms).not.toHaveBeenCalled()
    })
  })
})
