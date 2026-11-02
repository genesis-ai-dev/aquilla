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
    applyPlace: vi.fn(async (_c, id, place) => {
      takes[id] = { ...takes[id], targetOffsetMs: place.targetOffsetMs, recordingsOffsetMs: place.recordingsOffsetMs }
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

// AQU-2267: a move states the take's place in both timings, and undo takes
// both back together, in one step.
describe("take.place in both timings (AQU-2267)", () => {
  const move = {
    cellId: "c", audioId: "a",
    before: -1_000, after: -800,
    recordingsBefore: null, recordingsAfter: 200,
  }

  it("undo puts both places back in one step, and redo moves both again", async () => {
    const takes: Takes = { a: { targetOffsetMs: -800, recordingsOffsetMs: 200 } }
    const { ctx, handlers } = ctxFor(takes)
    expect(await handlers["take.place"].undo(move)).toEqual({ kind: "done" })
    expect(ctx.applyPlace).toHaveBeenCalledTimes(1)
    expect(ctx.applyPlace).toHaveBeenCalledWith("c", "a", { targetOffsetMs: -1_000, recordingsOffsetMs: null })
    expect(await handlers["take.place"].redo(move)).toEqual({ kind: "done" })
    expect(ctx.applyPlace).toHaveBeenLastCalledWith("c", "a", { targetOffsetMs: -800, recordingsOffsetMs: 200 })
  })

  it("is skipped as changed once someone has moved the take following the recordings since", async () => {
    const { ctx, handlers } = ctxFor({ a: { targetOffsetMs: -800, recordingsOffsetMs: 600 } })
    expect(await handlers["take.place"].undo(move)).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.applyPlace).not.toHaveBeenCalled()
  })

  it("a step saved before AQU-2267 names one place: it undoes that one, with no place of its own following the recordings", async () => {
    const { ctx, handlers } = ctxFor({ a: { targetOffsetMs: 200 } })
    expect(await handlers["take.place"].undo({ cellId: "c", audioId: "a", before: -1_000, after: 200 })).toEqual({ kind: "done" })
    expect(ctx.applyPlace).toHaveBeenCalledWith("c", "a", { targetOffsetMs: -1_000, recordingsOffsetMs: null })
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

  // AQU-2267: moved since following the recordings counts as moved.
  it("is skipped once someone has moved a piece following the recordings", async () => {
    const { ctx, handlers } = ctxFor({ a: { trimEndMs: 1500 }, b: { trimStartMs: 1500, recordingsOffsetMs: 900, pieceOf: "a" } })
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

  it("a split take deleted whole comes back piece by piece in one undo, and goes again in one redo", async () => {
    const takes: Takes = { a: { isDeleted: true }, b: { isDeleted: true } }
    const { ctx, handlers } = ctxFor(takes)
    const data = { cellId: "c", audioId: "a", slot: "recording", wasSelected: true, selectedBefore: null, pieces: ["b"] }
    expect(await handlers["take.remove"].undo(data)).toEqual({ kind: "done" })
    expect((ctx.select as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ["c", "recording", "a"],
      ["c", "recording", "b"],
    ])
    takes.a = {}
    takes.b = {}
    expect(await handlers["take.remove"].redo(data)).toEqual({ kind: "done" })
    expect((ctx.remove as ReturnType<typeof vi.fn>).mock.calls).toEqual([["c", "a"], ["c", "b"]])
  })

  it("undoing a whole-take delete is skipped once any piece is back", async () => {
    const { handlers } = ctxFor({ a: { isDeleted: true }, b: {} })
    const data = { cellId: "c", audioId: "a", slot: "recording", wasSelected: true, selectedBefore: null, pieces: ["b"] }
    expect(await handlers["take.remove"].undo(data)).toEqual({ kind: "skipped", reason: "changed" })
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

// Decision 11: recording, uploading, generating, changing a voice and removing
// noise each ADD a take; undo takes it away and plays what played before.
describe("take.add", () => {
  /** A cell whose slot "recording" plays `playing`; remove/select update it. */
  function cell(takes: Takes, playing: { id: string | null }) {
    return ctxFor(takes, {
      selectedIn: () => playing.id,
      remove: vi.fn(async (_c, id) => {
        takes[id] = { ...takes[id], isDeleted: true }
        if (playing.id === id) playing.id = null
      }),
      select: vi.fn(async (_c, _slot, id) => {
        if (id) takes[id] = { ...takes[id], isDeleted: false }
        playing.id = id
      }),
      approvedByOthers: (_c, id) => (takes[id]?.validators ?? []).find((v) => v !== "asha") ?? null,
      liveGroup: (_c, id) => Object.keys(takes).filter((k) => !takes[k].isDeleted && (takes[k].pieceOf ?? k) === id),
      takeRemoved: vi.fn(),
      takeRestored: vi.fn(),
    })
  }
  const added = { cellId: "c", audioId: "new", slot: "recording", selectedBefore: "take1" }

  it("undo removes the new take and plays the old one again; redo brings the new one back", async () => {
    const takes: Takes = { take1: { slot: "recording" }, new: { slot: "recording", validators: ["asha"] } }
    const playing = { id: "new" as string | null }
    const { ctx, handlers } = cell(takes, playing)
    expect(await handlers["take.add"].undo(added)).toEqual({ kind: "done" })
    expect(ctx.remove).toHaveBeenCalledWith("c", "new")
    expect(playing.id).toBe("take1")
    expect(ctx.takeRemoved).toHaveBeenCalledWith("c", ["new"])
    expect(await handlers["take.add"].redo(added)).toEqual({ kind: "done" })
    expect(playing.id).toBe("new")
    expect(takes.new.isDeleted).toBe(false)
    expect(ctx.takeRestored).toHaveBeenCalledWith("c")
  })

  it("is skipped, naming them, once someone else has approved the new take (gap 25)", async () => {
    const takes: Takes = { take1: {}, new: { validators: ["asha", "ben"] } }
    const { ctx, handlers } = cell(takes, { id: "new" })
    expect(await handlers["take.add"].undo(added)).toEqual({ kind: "skipped", reason: "approved", by: "ben" })
    expect(ctx.remove).not.toHaveBeenCalled()
  })

  it("is skipped once it was cut or trimmed since", async () => {
    const cut: Takes = { take1: {}, new: {}, piece: { pieceOf: "new" } }
    expect(await cell(cut, { id: "new" }).handlers["take.add"].undo(added)).toEqual({ kind: "skipped", reason: "changed" })
    const trimmed: Takes = { take1: {}, new: { trimStartMs: 300 } }
    const born = { ...added, window: { trimStartMs: 200, trimEndMs: undefined } }
    expect(await cell(trimmed, { id: "new" }).handlers["take.add"].undo(born)).toEqual({ kind: "skipped", reason: "changed" })
  })

  it("leaves the slot alone when another take was chosen since, or the old one is gone", async () => {
    const takes: Takes = { take1: {}, other: {}, new: {} }
    const playing = { id: "other" as string | null }
    const { ctx, handlers } = cell(takes, playing)
    expect(await handlers["take.add"].undo(added)).toEqual({ kind: "done" })
    expect(ctx.select).not.toHaveBeenCalled()
    expect(playing.id).toBe("other")
  })

  it("a cleaned split take comes and goes with all its pieces", async () => {
    const takes: Takes = { take1: {}, dn: {}, "dn-2": { pieceOf: "dn" } }
    const playing = { id: "dn" as string | null }
    const { ctx, handlers } = cell(takes, playing)
    const data = { ...added, audioId: "dn", pieces: ["dn-2"] }
    expect(await handlers["take.add"].undo(data)).toEqual({ kind: "done" })
    expect(ctx.remove).toHaveBeenCalledTimes(2)
    expect(await handlers["take.add"].redo(data)).toEqual({ kind: "done" })
    expect(ctx.select).toHaveBeenLastCalledWith("c", "recording", "dn-2")
  })

  it("redo is skipped when someone brought the take back already; undo of a take already gone is skipped as gone", async () => {
    const live: Takes = { take1: {}, new: {} }
    expect(await cell(live, { id: "new" }).handlers["take.add"].redo(added)).toEqual({ kind: "skipped", reason: "changed" })
    const gone: Takes = { take1: {} }
    expect(await cell(gone, { id: "take1" }).handlers["take.add"].undo(added)).toEqual({ kind: "skipped", reason: "gone" })
  })

  it("a transcript that arrives after the undo does not bring the take back", async () => {
    const { wasTakeUndone } = await import("@/lib/audio/undone-takes")
    const takes: Takes = { take1: {}, late: {} }
    const { handlers } = cell(takes, { id: "late" })
    await handlers["take.add"].undo({ ...added, audioId: "late" })
    expect(wasTakeUndone("late")).toBe(true)
    await handlers["take.add"].redo({ ...added, audioId: "late" })
    expect(wasTakeUndone("late")).toBe(false)
  })
})

describe("take.select that emptied a slot", () => {
  it("undo plays the old take again; redo empties the slot again", async () => {
    const select = vi.fn(async () => {})
    let playing: string | null = null
    const { handlers } = ctxFor({ take1: {} }, { selectedIn: () => playing, select })
    const data = { cellId: "c", slot: "recording", before: "take1", after: null }
    expect(await handlers["take.select"].undo(data)).toEqual({ kind: "done" })
    expect(select).toHaveBeenLastCalledWith("c", "recording", "take1")
    playing = "take1"
    expect(await handlers["take.select"].redo(data)).toEqual({ kind: "done" })
    expect(select).toHaveBeenLastCalledWith("c", "recording", null)
  })
})
