// AQU-1767: undo and redo of trims, moves, cuts — and (phase 2) choosing,
// deleting and renaming takes — with the "changed since" guard.
import { describe, it, expect, vi } from "vitest"
import { takeStepHandlers, type CutRecord, type TakeStepContext } from "./take-steps"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { StepHandler } from "./history"

type Takes = Record<string, Partial<CodexCellAttachment>>

function ctxFor(takes: Takes, overrides: Partial<TakeStepContext> = {}) {
  const ctx: TakeStepContext = {
    readTake: (_c, id) => (takes[id] && !takes[id].isDeleted ? (takes[id] as CodexCellAttachment) : null),
    selectedIn: () => null,
    applyTrim: vi.fn(async (_c, id, w) => {
      takes[id] = { ...takes[id], trimStartMs: w.trimStartMs, trimEndMs: w.trimEndMs }
    }),
    applyPlace: vi.fn(async (_c, id, offset) => {
      takes[id] = { ...takes[id], targetOffsetMs: offset }
    }),
    cut: vi.fn(async () => true),
    uncut: vi.fn(async () => {}),
    newPieceId: () => "fresh",
    select: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    ...overrides,
  }
  return { ctx, handlers: takeStepHandlers(ctx) as Record<string, StepHandler<unknown>> }
}

describe("take.window / take.place", () => {
  it("puts the old window back only while the take still has the new one", async () => {
    const takes: Takes = { a: { trimStartMs: 100, trimEndMs: 900 } }
    const { ctx, handlers } = ctxFor(takes)
    const data = { cellId: "c", audioId: "a", before: { trimStartMs: 0, trimEndMs: 1000 }, after: { trimStartMs: 100, trimEndMs: 900 } }
    expect(await handlers["take.window"].undo(data)).toEqual({ kind: "done" })
    expect(takes.a).toMatchObject({ trimStartMs: 0, trimEndMs: 1000 })
    takes.a = { trimStartMs: 50, trimEndMs: 1000 } // somebody trimmed it since
    expect(await handlers["take.window"].redo(data)).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.applyTrim).toHaveBeenCalledTimes(1)
  })

  it("a move whose take is gone is skipped as gone", async () => {
    const { handlers } = ctxFor({})
    expect(await handlers["take.place"].undo({ cellId: "c", audioId: "a", before: null, after: 250 })).toEqual({
      kind: "skipped",
      reason: "gone",
    })
  })
})

describe("take.cut", () => {
  const record = (): CutRecord => ({
    cellId: "c1", audioId: "a", atMs: 1500, newAudioId: "b",
    before: { trimEndMs: null, label: "Take 1", targetOffsetMs: null },
    renamed: true,
  })

  it("undo joins the halves back while both are exactly as the cut left them", async () => {
    const { ctx, handlers } = ctxFor({ a: { trimEndMs: 1500 }, b: { trimStartMs: 1500, pieceOf: "a" } })
    expect(await handlers["take.cut"].undo({ cuts: [record()] })).toEqual({ kind: "done" })
    expect(ctx.uncut).toHaveBeenCalledTimes(1)
  })

  it("is skipped once someone has moved or trimmed a piece, and nothing is joined", async () => {
    const { ctx, handlers } = ctxFor({ a: { trimEndMs: 1500 }, b: { trimStartMs: 1500, targetOffsetMs: 400, pieceOf: "a" } })
    expect(await handlers["take.cut"].undo({ cuts: [record()] })).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.uncut).not.toHaveBeenCalled()
  })

  it("redo cuts again with a fresh id, only while the take is whole", async () => {
    const { ctx, handlers } = ctxFor({ a: {} })
    const rec = record()
    expect(await handlers["take.cut"].redo({ cuts: [rec] })).toEqual({ kind: "done" })
    expect(ctx.cut).toHaveBeenCalledWith(rec, "fresh")
    expect(rec.newAudioId).toBe("fresh")
  })
})

describe("take.select / take.remove / take.rename", () => {
  it("choosing a take is undone by choosing the previous one, while it still plays", async () => {
    let playing: string | null = "b"
    const { ctx, handlers } = ctxFor({ a: {}, b: {} }, { selectedIn: () => playing })
    const data = { cellId: "c", slot: "recording", before: "a", after: "b" }
    expect(await handlers["take.select"].undo(data)).toEqual({ kind: "done" })
    expect(ctx.select).toHaveBeenCalledWith("c", "recording", "a")
    playing = "z" // somebody chose another since
    expect(await handlers["take.select"].redo(data)).toEqual({ kind: "skipped", reason: "changed" })
  })

  it("a deleted take comes back by choosing it, and the slot gets its old choice back", async () => {
    const { ctx, handlers } = ctxFor({ a: { isDeleted: true }, b: {} }, { selectedIn: () => "b" })
    const data = { cellId: "c", audioId: "a", slot: "recording", wasSelected: false, selectedBefore: null }
    expect(await handlers["take.remove"].undo(data)).toEqual({ kind: "done" })
    expect((ctx.select as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ["c", "recording", "a"],
      ["c", "recording", "b"],
    ])
  })

  it("undoing a delete is skipped when the take is already back", async () => {
    const { handlers } = ctxFor({ a: {} })
    const data = { cellId: "c", audioId: "a", slot: "recording", wasSelected: true, selectedBefore: null }
    expect(await handlers["take.remove"].undo(data)).toEqual({ kind: "skipped", reason: "changed" })
  })

  it("a rename goes back while the take still has the new name", async () => {
    const { ctx, handlers } = ctxFor({ a: { label: "Hero line" } })
    const data = { cellId: "c", audioId: "a", before: "Take 3", after: "Hero line" }
    expect(await handlers["take.rename"].undo(data)).toEqual({ kind: "done" })
    expect(ctx.rename).toHaveBeenCalledWith("c", "a", "Take 3")
  })

  it("a rename undone before the new name has shown still goes back", async () => {
    const { ctx, handlers } = ctxFor({ a: { label: "Take 3" } })
    const data = { cellId: "c", audioId: "a", before: "Take 3", after: "Hero line" }
    expect(await handlers["take.rename"].undo(data)).toEqual({ kind: "done" })
    expect(ctx.rename).toHaveBeenCalledWith("c", "a", "Take 3")
  })

  it("a rename someone else renamed again is left alone", async () => {
    const { ctx, handlers } = ctxFor({ a: { label: "Narrator" } })
    const data = { cellId: "c", audioId: "a", before: "Take 3", after: "Hero line" }
    expect(await handlers["take.rename"].undo(data)).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.rename).not.toHaveBeenCalled()
  })
})
