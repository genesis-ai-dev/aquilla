// Decision 11 (P13.6, gap 30): making lines from a recording can be undone
// only while every line is untouched, and an imported recording goes to
// Recently deleted and comes back from there.
import { describe, it, expect, vi } from "vitest"
import { recordingLinesStepHandlers, type RecordingLinesContext } from "./recording-lines-steps"
import type { StepHandler } from "./history"

type Line = { untouched: boolean; head: string }

function ctxFor(lines: Map<string, Line>, files: Record<string, "live" | "deleted"> = {}, open = "f1") {
  const removed = new Map<string, Line>()
  const ctx: RecordingLinesContext = {
    lineUntouched: (cellId, eventId) => {
      const l = lines.get(cellId)
      if (!l) return null
      return l.untouched && (eventId == null || l.head === eventId)
    },
    removeLine: vi.fn(async (cellId) => {
      const l = lines.get(cellId)
      if (!l) return false
      removed.set(cellId, l)
      lines.delete(cellId)
      return true
    }),
    restoreLine: vi.fn(async (cellId) => {
      const l = removed.get(cellId)
      if (!l) return false
      lines.set(cellId, l)
      return true
    }),
    fileState: (fileId) => files[fileId] ?? null,
    fileUntouched: (fileId) => (fileId !== open ? "notOpen" : [...lines.values()].every((l) => l.untouched)),
    trashFile: vi.fn(async (fileId) => {
      files[fileId] = "deleted"
    }),
    restoreFile: vi.fn(async (fileId) => {
      files[fileId] = "live"
    }),
  }
  return { ctx, handlers: recordingLinesStepHandlers(ctx) as Record<string, StepHandler<unknown>> }
}

const made = { lines: [{ cellId: "l1", eventId: "e1" }, { cellId: "l2", eventId: "e2" }, { cellId: "l3", eventId: "e3" }] }
const fresh = () =>
  new Map<string, Line>([
    ["l1", { untouched: true, head: "e1" }],
    ["l2", { untouched: true, head: "e2" }],
    ["l3", { untouched: true, head: "e3" }],
  ])

describe("lines.fromRecording", () => {
  it("undo removes every line, last first, and redo brings the same lines back", async () => {
    const lines = fresh()
    const { ctx, handlers } = ctxFor(lines)
    expect(await handlers["lines.fromRecording"].undo(made)).toEqual({ kind: "done" })
    expect(lines.size).toBe(0)
    expect(vi.mocked(ctx.removeLine).mock.calls.map((c) => c[0])).toEqual(["l3", "l2", "l1"])
    expect(await handlers["lines.fromRecording"].redo(made)).toEqual({ kind: "done" })
    expect([...lines.keys()].sort()).toEqual(["l1", "l2", "l3"])
  })

  // Slice 13 evidence (Oct 27): Lena, a Project lead, made the lines and
  // pressed Undo; the five removals were queued and the server refused each
  // ("removing an imported cell requires maintainer"), leaving "5 failed" and
  // every line in place. Someone who may not remove them is told instead.
  it("is skipped, removing nothing, when this person may not remove the lines", async () => {
    const lines = fresh()
    const { ctx, handlers } = ctxFor(lines)
    ctx.mayRemoveLine = () => false
    expect(await handlers["lines.fromRecording"].undo(made)).toEqual({ kind: "skipped", reason: "notAllowed" })
    expect(ctx.removeLine).not.toHaveBeenCalled()
    expect(lines.size).toBe(3)
    ctx.mayRemoveLine = () => true
    expect(await handlers["lines.fromRecording"].undo(made)).toEqual({ kind: "done" })
    expect(lines.size).toBe(0)
  })

  it("once anyone has recorded on one line, the whole step is skipped and every line stays", async () => {
    const lines = fresh()
    lines.set("l2", { untouched: false, head: "e2" }) // Asha recorded a take on line 2
    const { ctx, handlers } = ctxFor(lines)
    expect(await handlers["lines.fromRecording"].undo(made)).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.removeLine).not.toHaveBeenCalled()
    expect(lines.size).toBe(3)
  })

  it("a line edited or moved since (its head moved on) counts as touched", async () => {
    const lines = fresh()
    lines.set("l1", { untouched: true, head: "edited" })
    expect(await ctxFor(lines).handlers["lines.fromRecording"].undo(made)).toEqual({ kind: "skipped", reason: "changed" })
  })
})

describe("file.importRecording", () => {
  it("undo moves the untouched file to Recently deleted, and redo brings it back", async () => {
    const files: Record<string, "live" | "deleted"> = { f1: "live" }
    const { handlers } = ctxFor(fresh(), files)
    expect(await handlers["file.importRecording"].undo({ fileId: "f1" })).toEqual({ kind: "done" })
    expect(files.f1).toBe("deleted")
    expect(await handlers["file.importRecording"].redo({ fileId: "f1" })).toEqual({ kind: "done" })
    expect(files.f1).toBe("live")
  })

  it("waits for the file to be open to see its lines, and is skipped once they were worked on", async () => {
    const files: Record<string, "live" | "deleted"> = { f1: "live" }
    expect(await ctxFor(fresh(), files, "other").handlers["file.importRecording"].undo({ fileId: "f1" })).toEqual({
      kind: "blocked",
      reason: "elsewhere",
    })
    const worked = fresh()
    worked.set("l1", { untouched: false, head: "e1" })
    expect(await ctxFor(worked, files).handlers["file.importRecording"].undo({ fileId: "f1" })).toEqual({
      kind: "skipped",
      reason: "changed",
    })
  })
})
