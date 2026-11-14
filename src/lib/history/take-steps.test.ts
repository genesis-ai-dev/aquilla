// AQU-1767: undo and redo of trims, moves, cuts — and (phase 2) choosing,
// deleting and renaming takes — with the "changed since" guard.
import { beforeEach, describe, it, expect, vi } from "vitest"
import { recordTakeWindowRun, takeStepHandlers, type CutRecord, type PieceStretch, type TakeAddData, type TakeRemoveData, type TakeStepContext } from "./take-steps"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import {
  historyReady,
  historyView,
  matchingSteps,
  recordGroup,
  recordStep,
  registerStepKinds,
  resetHistoryForTests,
  setHistoryScope,
  undoLast,
  type StepHandler,
} from "./history"
import { clearHistoryStoreForTests } from "./history-store"

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

  // Merge review round 2, note R2-2: the workspace's trim write stores nothing
  // when the window can no longer play (wholly before 0:00 after a colleague's
  // drag) and says so; the step reports the take as changed.
  it("a window the trim write could not store is skipped as changed", async () => {
    const takes: Takes = { a: { trimStartMs: 100, trimEndMs: 900 } }
    const { handlers } = ctxFor(takes, { applyTrim: vi.fn(async () => false) })
    const data = { cellId: "c", audioId: "a", before: { trimStartMs: 0, trimEndMs: 1000 }, after: { trimStartMs: 100, trimEndMs: 900 } }
    expect(await handlers["take.window"].undo(data)).toEqual({ kind: "skipped", reason: "changed" })
    expect(takes.a).toMatchObject({ trimStartMs: 100, trimEndMs: 900 })
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

  // AQU-2432 (Sam, Nov 6): a take dragged over the end of the take before it
  // has a place below its line's start following the recordings.
  it("a move back over the take before it is undone and redone as one step, its place below 0 kept", async () => {
    const pulled = { cellId: "c", audioId: "a", before: -1_000, after: -1_600, recordingsBefore: 0, recordingsAfter: -600 }
    const takes: Takes = { a: { targetOffsetMs: -1_600, recordingsOffsetMs: -600 } }
    const { ctx, handlers } = ctxFor(takes)
    expect(await handlers["take.place"].undo(pulled)).toEqual({ kind: "done" })
    expect(ctx.applyPlace).toHaveBeenCalledWith("c", "a", { targetOffsetMs: -1_000, recordingsOffsetMs: 0 })
    expect(await handlers["take.place"].redo(pulled)).toEqual({ kind: "done" })
    expect(takes.a).toMatchObject({ targetOffsetMs: -1_600, recordingsOffsetMs: -600 })
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

  // AQU-2492 (review, Nov 9; Sam's call the same day): the Redo names the
  // piece the Undo removed, which the server brings back with its approvals.
  it("redo cuts again naming the same piece, only while the take is whole", async () => {
    const { ctx, handlers } = ctxFor({ a: {} })
    const rec = record()
    expect(await handlers["take.cut"].redo({ cuts: [rec] })).toEqual({ kind: "done" })
    expect(ctx.cut).toHaveBeenCalledWith(rec, "b")
    expect(rec.newAudioId).toBe("b")
  })
})

// AQU-2492 (Sam, Nov 11): a colleague deletes the second half of my cut and I
// press ⌘Z. One result, whether or not my page has heard of the delete yet, in
// every browser: the cut is undone on what is left and the whole take's
// approvals come back (the server's undo does both either way). The browser
// pass found it joined only while the page still drew the half (Chrome's
// engine, 0.15 s after the delete) and was skipped as gone once it had heard
// (Safari's engine at the same moment, and both later), losing the approvals
// the take had before the cut for good.
describe("take.cut after a colleague deleted its second half (AQU-2492, Nov 11)", () => {
  const level = { gainDb: 6, fadeInMs: 300, fadeOutMs: 500 }
  const record = (over: Partial<CutRecord["before"]> = {}): CutRecord => ({
    cellId: "c1", audioId: "a", atMs: 1700, newAudioId: "b",
    before: { trimEndMs: null, label: "Take 1", targetOffsetMs: null, validators: ["alice", "carol"], ...over },
    renamed: true,
  })

  it("the page has heard of the delete: Undo joins the take on what is left, as it does when it has not", async () => {
    const heard = ctxFor({ a: { trimEndMs: 1700 } })
    const notYet = ctxFor({ a: { trimEndMs: 1700 }, b: { trimStartMs: 1700, pieceOf: "a" } })
    const rec = record()
    expect(await heard.handlers["take.cut"].undo({ cuts: [rec] })).toEqual({ kind: "done" })
    expect(heard.ctx.uncut).toHaveBeenCalledWith(rec)
    expect(await notYet.handlers["take.cut"].undo({ cuts: [record()] })).toEqual({ kind: "done" })
    expect(notYet.ctx.uncut).toHaveBeenCalledTimes(1)
    // What the joined take gets back is the take's approvals from before the
    // cut, the same either way; the gone half has none to note.
    expect(rec.before.validators).toEqual(["alice", "carol"])
    expect(rec.pieceVoters?.second).toEqual([])
  })

  it("with the take's volume and fades: the first half is checked, and is enough", async () => {
    const { ctx, handlers } = ctxFor({ a: { trimEndMs: 1700, ...level } })
    expect(await handlers["take.cut"].undo({ cuts: [record({ level })] })).toEqual({ kind: "done" })
    expect(ctx.uncut).toHaveBeenCalledTimes(1)
  })

  it("someone worked on the first half since: skipped as changed, as with both halves there", async () => {
    const trimmed = ctxFor({ a: { trimEndMs: 1200 } })
    expect(await trimmed.handlers["take.cut"].undo({ cuts: [record()] })).toEqual({ kind: "skipped", reason: "changed" })
    const louder = ctxFor({ a: { trimEndMs: 1700, ...level, gainDb: 0 } })
    expect(await louder.handlers["take.cut"].undo({ cuts: [record({ level })] })).toEqual({ kind: "skipped", reason: "changed" })
    expect(trimmed.ctx.uncut).not.toHaveBeenCalled()
    expect(louder.ctx.uncut).not.toHaveBeenCalled()
  })
})

// AQU-2492 (review, Nov 12): ONE RULE for every Undo or Redo that joins a cut
// take, cuts it again or brings a deleted piece back: it never leaves two
// pieces of one take over the same stretch of its recording (it would play
// twice). Read from the take's live pieces; skipped as changed since.
describe("an Undo or Redo never leaves two pieces of one take over one stretch (AQU-2492, Nov 12)", () => {
  type Live = Takes
  // The workspace's own reading: a take's live pieces are its first piece and
  // every live piece naming it.
  const withGroups = (takes: Live) => ctxFor(takes, {
    liveGroup: (_c, id) => {
      const group = takes[id]?.pieceOf ?? id
      return Object.entries(takes).filter(([k, t]) => !t.isDeleted && (t.pieceOf ?? k) === group).map(([k]) => k)
    },
  })
  const ORIG = "frontier-audio://take.wav"
  const cutAt1s = (): CutRecord => ({
    cellId: "c1", audioId: "T", atMs: 1000, newAudioId: "P2",
    before: { trimEndMs: null, label: "Take 1", targetOffsetMs: null, validators: ["alice"] },
    renamed: true,
  })

  it("the decided case still joins: a colleague deleted the second half, and nothing else plays it", async () => {
    const { ctx, handlers } = withGroups({ T: { url: ORIG, trimEndMs: 1000, durationMs: 4000 }, P2: { url: ORIG, trimStartMs: 1000, durationMs: 4000, pieceOf: "T", isDeleted: true } })
    expect(await handlers["take.cut"].undo({ cuts: [cutAt1s()] })).toEqual({ kind: "done" })
    expect(ctx.uncut).toHaveBeenCalledTimes(1)
  })

  // Review, case A: bob cut the second half again at 2 s and deleted the
  // middle piece. Joining would play 2 s to the end twice.
  it("skips the Undo when a colleague cut the second half again and deleted the middle piece", async () => {
    const { ctx, handlers } = withGroups({
      T: { url: ORIG, trimEndMs: 1000, durationMs: 4000 },
      P2: { url: ORIG, trimStartMs: 1000, trimEndMs: 2000, durationMs: 4000, pieceOf: "T", isDeleted: true },
      P3: { url: ORIG, trimStartMs: 2000, durationMs: 4000, pieceOf: "T" },
    })
    expect(await handlers["take.cut"].undo({ cuts: [cutAt1s()] })).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.uncut).not.toHaveBeenCalled()
  })

  // Review, case B: the Station's Save over the second half removed it and
  // put the edited recording in its place, as a piece of the same take.
  it("skips the Undo when a colleague saved the second half over in the Station", async () => {
    const { ctx, handlers } = withGroups({
      T: { url: ORIG, trimEndMs: 1000, durationMs: 4000 },
      P2: { url: ORIG, trimStartMs: 1000, durationMs: 4000, pieceOf: "T", isDeleted: true },
      S2: { trimStartMs: 1000, durationMs: 4200, pieceOf: "T", url: "frontier-audio://station.wav", referenceAudioId: "P2" },
    })
    expect(await handlers["take.cut"].undo({ cuts: [cutAt1s()] })).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.uncut).not.toHaveBeenCalled()
  })

  // Review, finding 2: dev's Undo joined the take (as decided); bob then
  // undoes his own delete of the second half, which would play twice.
  it("skips the colleague's Undo of his delete once the take was joined, and allows it while it was not", async () => {
    const deleted = { cellId: "c1", audioId: "P2", slot: "recording", wasSelected: true, selectedBefore: null, stretches: { P2: { url: ORIG, pieceOf: "T", startMs: 1000, endMs: 4000 } } }
    const joinedTake = withGroups({ T: { url: ORIG, durationMs: 4000 } })
    expect(await joinedTake.handlers["take.remove"].undo(deleted)).toEqual({ kind: "skipped", reason: "changed" })
    expect(joinedTake.ctx.select).not.toHaveBeenCalled()
    const stillCut = withGroups({ T: { url: ORIG, trimEndMs: 1000, durationMs: 4000 } })
    expect(await stillCut.handlers["take.remove"].undo(deleted)).toEqual({ kind: "done" })
    expect(stillCut.ctx.select).toHaveBeenCalledWith("c1", "recording", "P2")
  })

  // The Station's own Save over a piece is one step: its Undo brings the old
  // piece back and takes away the version that replaced it.
  it("the Undo of a Station Save over a piece still brings the old piece back", async () => {
    const { ctx, handlers } = withGroups({ T: { url: ORIG, trimEndMs: 1000, durationMs: 4000 }, S2: { url: "frontier-audio://station.wav", trimStartMs: 1000, durationMs: 4200, pieceOf: "T", referenceAudioId: "P2" } })
    const savedOver = { cellId: "c1", audioId: "P2", slot: "recording", wasSelected: true, selectedBefore: null, replacedBy: "S2", stretches: { P2: { url: ORIG, pieceOf: "T", startMs: 1000, endMs: 4000 } } }
    expect(await handlers["take.remove"].undo(savedOver)).toEqual({ kind: "done" })
    expect(ctx.select).toHaveBeenCalledWith("c1", "recording", "P2")
  })

  // The Redo would bring the second half back over a stretch another piece
  // plays by then: the server's cut would land on nothing, yet say "Redid".
  it("skips a Redo that another piece's stretch would turn into a cut of nothing", async () => {
    const { ctx, handlers } = withGroups({ T: { url: ORIG, durationMs: 4000 }, Q: { url: ORIG, trimStartMs: 2000, durationMs: 4000, pieceOf: "T" } })
    expect(await handlers["take.cut"].redo({ cuts: [cutAt1s()] })).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.cut).not.toHaveBeenCalled()
  })

  it("a Redo with nothing else over the take cuts it again", async () => {
    const { ctx, handlers } = withGroups({ T: { url: ORIG, durationMs: 4000 } })
    expect(await handlers["take.cut"].redo({ cuts: [cutAt1s()] })).toEqual({ kind: "done" })
    expect(ctx.cut).toHaveBeenCalledTimes(1)
  })
})

// AQU-2492 (review, round 2): pieces the Station saved. Such a piece is a
// part of a new, edited recording; it stands for the stretch of the piece it
// was made from (`referenceAudioId`), never for its own numbers against the
// original's, and the Station's Save notes that stretch on both halves of its
// step so its Undo and Redo are held to the same rule.
describe("pieces the Station saved (AQU-2492, review round 2)", () => {
  const ORIG = "frontier-audio://take.wav"
  const STN = "frontier-audio://station.wav"
  type Take = Partial<CodexCellAttachment> & { isDeleted?: boolean }
  // A take whose writes land, so a sequence of steps can run on it.
  function sequence(takes: Record<string, Take>) {
    const live = (id: string) => (takes[id] && !takes[id].isDeleted ? (takes[id] as CodexCellAttachment) : null)
    const ctx: TakeStepContext = {
      readTake: (_c, id) => live(id),
      selectedIn: () => null,
      applyTrim: vi.fn(async () => {}),
      applyPlace: vi.fn(async () => {}),
      cut: vi.fn(async (c: CutRecord) => {
        takes[c.audioId] = { ...takes[c.audioId], trimEndMs: c.atMs }
        takes[c.newAudioId] = { ...(takes[c.newAudioId] ?? {}), url: takes[c.audioId].url, trimStartMs: c.atMs, trimEndMs: c.before.trimEndMs ?? undefined, pieceOf: c.audioId, isDeleted: false }
        return true
      }),
      uncut: vi.fn(async (c: CutRecord) => {
        takes[c.audioId] = { ...takes[c.audioId], trimEndMs: c.before.trimEndMs ?? undefined }
        if (takes[c.newAudioId]) takes[c.newAudioId] = { ...takes[c.newAudioId], isDeleted: true }
      }),
      select: vi.fn(async (_c, _s, id) => { if (id && takes[id]) takes[id] = { ...takes[id], isDeleted: false } }),
      remove: vi.fn(async (_c, id) => { if (takes[id]) takes[id] = { ...takes[id], isDeleted: true } }),
      rename: vi.fn(async () => {}),
      liveGroup: (_c, id) => {
        const group = live(id)?.pieceOf ?? id
        return Object.entries(takes).filter(([k, t]) => !t.isDeleted && (t.pieceOf ?? k) === group).map(([k]) => k)
      },
    }
    return { takes, ctx, h: takeStepHandlers(ctx) as Record<string, StepHandler<unknown>> }
  }
  const cutAt1s: CutRecord = {
    cellId: "c1", audioId: "T", atMs: 1000, newAudioId: "P2",
    before: { trimEndMs: null, label: "Take 1", targetOffsetMs: null, validators: ["alice", "carol"] },
    renamed: true,
  }
  const P2_STRETCH: PieceStretch = { pieceOf: "T", url: ORIG, startMs: 1000, endMs: 4000 }
  // bob's Save over the second half in the Station, as save.ts records it.
  const stationAdd: TakeAddData = { cellId: "c1", audioId: "S2", slot: "recording", selectedBefore: "T", replaces: "P2", stretches: { S2: P2_STRETCH } }
  const stationRemove: TakeRemoveData = { cellId: "c1", audioId: "P2", slot: "recording", wasSelected: true, selectedBefore: "T", replacedBy: "S2", stretches: { P2: P2_STRETCH } }
  const DONE = { kind: "done" }
  const CHANGED = { kind: "skipped", reason: "changed" }
  const S2: Take = { url: STN, trimStartMs: 1000, durationMs: 4200, pieceOf: "T", referenceAudioId: "P2" }

  beforeEach(async () => {
    resetHistoryForTests()
    await clearHistoryStoreForTests()
    setHistoryScope("p1", "bob")
    await historyReady()
    recordGroup({ labelKey: "editor.history.stepStationSaveOver", fileId: "f1" }, [
      { kind: "take.add", data: stationAdd, labelKey: "editor.history.stepStationVersion", fileId: "f1" },
      { kind: "take.remove", data: stationRemove, labelKey: "editor.history.stepDeleteTake", fileId: "f1" },
    ])
  })

  it("its own Undo and Redo, with nothing else in between: the old piece comes back and goes again", async () => {
    const { takes, h } = sequence({ T: { url: ORIG, trimEndMs: 1000, durationMs: 4000 }, P2: { url: ORIG, trimStartMs: 1000, durationMs: 4000, pieceOf: "T", isDeleted: true }, S2 })
    // Undo, newest part first: the old piece back, then the version gone
    // (that half's own Undo of a piece is AQU-2493's, `joined`; here it is
    // done as it does it).
    expect(await h["take.remove"].undo(stationRemove)).toEqual(DONE)
    takes.S2 = { ...takes.S2, isDeleted: true }
    expect(takes.P2.isDeleted).toBe(false)
    // Redo, oldest part first: the version back, then the old piece gone.
    expect(await h["take.add"].redo(stationAdd)).toEqual(DONE)
    expect(await h["take.remove"].redo(stationRemove)).toEqual(DONE)
  })

  // Review, round 2, item 1: dev cut; bob saved the second half over and then
  // deleted his saved piece; dev's Undo joined the take. Neither of bob's two
  // Undos may bring a second half back over the joined take.
  it("after a join, neither the Undo of deleting the saved piece nor the Undo of the Save brings a half back", async () => {
    const { ctx, h } = sequence({ T: { url: ORIG, trimEndMs: 1000, durationMs: 4000 }, P2: { url: ORIG, trimStartMs: 1000, durationMs: 4000, pieceOf: "T", isDeleted: true }, S2: { ...S2, isDeleted: true } })
    expect(await h["take.cut"].undo({ cuts: [{ ...cutAt1s }] })).toEqual(DONE)
    // bob's delete noted the saved piece's own numbers, on its own recording.
    const deletedSaved: TakeRemoveData = { cellId: "c1", audioId: "S2", slot: "recording", wasSelected: true, selectedBefore: null, stretches: { S2: { pieceOf: "T", url: STN, startMs: 1000, endMs: 4200 } } }
    expect(await h["take.remove"].undo(deletedSaved)).toEqual(CHANGED)
    expect(await h["take.remove"].undo(stationRemove)).toEqual(CHANGED)
    expect(ctx.select).not.toHaveBeenCalled()
  })

  // Review, round 2, item 2 (the older path): dev cut; bob saved the second
  // half over and undid it; dev's Undo joined the take; bob redoes his Save.
  it("after a join, the Save's Redo does not bring its piece back over the whole take", async () => {
    const { ctx, h } = sequence({ T: { url: ORIG, trimEndMs: 1000, durationMs: 4000 }, P2: { url: ORIG, trimStartMs: 1000, durationMs: 4000, pieceOf: "T" }, S2: { ...S2, isDeleted: true } })
    expect(await h["take.cut"].undo({ cuts: [{ ...cutAt1s }] })).toEqual(DONE)
    expect(await h["take.add"].redo(stationAdd)).toEqual(CHANGED)
    expect(ctx.select).not.toHaveBeenCalled()
  })

  // Review, round 2, item 3, A: dev cut at 1 s and deleted the first half; bob
  // deleted 0.8 s at the start of the recording in the Station and saved the
  // second half (the original 1.0-4.0 s, 0.2-3.2 s of the new recording).
  // Nothing would play twice. Round 3: the saved piece stands for the half
  // dev's own cut made, read from his History; dev's Undo goes ahead.
  const deletedFirst: TakeRemoveData = { cellId: "c1", audioId: "T", slot: "recording", wasSelected: true, selectedBefore: null, stretches: { T: { pieceOf: "T", url: ORIG, startMs: 0, endMs: 1000 } } }
  const afterDeletingTheFirstHalf = () => sequence({ T: { url: ORIG, trimEndMs: 1000, durationMs: 4000, isDeleted: true }, P2: { url: ORIG, trimStartMs: 1000, durationMs: 4000, pieceOf: "T", isDeleted: true }, S2: { ...S2, trimStartMs: 200, trimEndMs: 3200, durationMs: 3200 } })
  it("audio deleted before a saved piece does not stop the Undo of deleting the piece before it, when this person made the cut", async () => {
    recordStep({ kind: "take.cut", data: { cuts: [cutAt1s] }, labelKey: "editor.history.stepCut", fileId: "f1" })
    expect(await afterDeletingTheFirstHalf().h["take.remove"].undo(deletedFirst)).toEqual(DONE)
  })
  // Round 3, when in doubt, refuse: without the cut in this person's History
  // nothing says what the saved piece stands for, so the Undo is skipped.
  it("…and is skipped when nothing says what the saved piece stands for", async () => {
    expect(await afterDeletingTheFirstHalf().h["take.remove"].undo(deletedFirst)).toEqual(CHANGED)
  })

  // Item 3, B: a take cut at 1 s and 4 s; bob inserted a 1 s pause inside the
  // middle piece and saved it (1.0-5.0 s of the new recording); dev deleted
  // the last piece and undoes that. Nothing would play twice, but the stretch
  // learned from the cut that made the middle piece runs to the take's end (a
  // later cut of it is not followed), so the Undo is skipped: one a perfect
  // rule would allow.
  it("a pause inserted inside a saved piece: the Undo of deleting the piece after it is skipped (known)", async () => {
    recordStep({ kind: "take.cut", data: { cuts: [cutAt1s] }, labelKey: "editor.history.stepCut", fileId: "f1" })
    recordStep({ kind: "take.cut", data: { cuts: [{ ...cutAt1s, audioId: "P2", atMs: 4000, newAudioId: "P3" }] }, labelKey: "editor.history.stepCut", fileId: "f1" })
    const { h } = sequence({
      T: { url: ORIG, trimEndMs: 1000, durationMs: 6000 },
      P2: { url: ORIG, trimStartMs: 1000, trimEndMs: 4000, durationMs: 6000, pieceOf: "T", isDeleted: true },
      S2: { ...S2, trimStartMs: 1000, trimEndMs: 5000, durationMs: 7000 },
      P3: { url: ORIG, trimStartMs: 4000, durationMs: 6000, pieceOf: "T", isDeleted: true },
    })
    const deletedLast: TakeRemoveData = { cellId: "c1", audioId: "P3", slot: "recording", wasSelected: true, selectedBefore: null, stretches: { P3: { pieceOf: "T", url: ORIG, startMs: 4000, endMs: 6000 } } }
    expect(await h["take.remove"].undo(deletedLast)).toEqual(CHANGED)
  })

  // Review, round 3, REGRESSION: dev cut at 1 s; bob cut the second half at
  // 2 s, saved its tail in the Station and deleted the middle piece. Joining
  // would run the take to its end under bob's Station tail: 2 s to the end
  // twice. Nothing in dev's History says what that tail stands for: skipped.
  it("a Station piece made from a piece this person did not make: dev's Undo of his cut is skipped", async () => {
    const { ctx, h } = sequence({
      T: { url: ORIG, trimEndMs: 1000, durationMs: 4000 },
      P2: { url: ORIG, trimStartMs: 1000, trimEndMs: 2000, pieceOf: "T", isDeleted: true },
      P3: { url: ORIG, trimStartMs: 2000, pieceOf: "T", isDeleted: true },
      S3: { url: STN, trimStartMs: 2000, durationMs: 4000, pieceOf: "T", referenceAudioId: "P3" },
    })
    expect(await h["take.cut"].undo({ cuts: [{ ...cutAt1s }] })).toEqual(CHANGED)
    expect(ctx.uncut).not.toHaveBeenCalled()
  })

  // Round 3: carol deletes bob's Station piece; dev's Undo joins the take;
  // carol's ⌘Z would bring the piece back over the whole take. Her History
  // holds no Save of it, so nothing says what it stands for: skipped.
  it("someone who did not save a Station piece undoes deleting it after a join: skipped", async () => {
    resetHistoryForTests()
    await clearHistoryStoreForTests()
    setHistoryScope("p1", "carol")
    await historyReady()
    const { ctx, h } = sequence({ T: { url: ORIG, trimEndMs: 1000, durationMs: 4000 }, P2: { url: ORIG, trimStartMs: 1000, durationMs: 4000, pieceOf: "T", isDeleted: true }, S2: { ...S2, isDeleted: true } })
    expect(await h["take.cut"].undo({ cuts: [{ ...cutAt1s }] })).toEqual(DONE)
    const carolDeleted: TakeRemoveData = { cellId: "c1", audioId: "S2", slot: "recording", wasSelected: true, selectedBefore: null, stretches: { S2: { pieceOf: "T", url: STN, startMs: 1000, endMs: 4200 } } }
    expect(await h["take.remove"].undo(carolDeleted)).toEqual(CHANGED)
    expect(ctx.select).not.toHaveBeenCalled()
  })

  // Still allowed with a Station piece in the take and nothing to fear.
  it("the decided case, a plain cut and Undo, and three pieces undone newest first still go ahead", async () => {
    const told = sequence({ T: { url: ORIG, trimEndMs: 1000, durationMs: 4000 }, P2: { url: ORIG, trimStartMs: 1000, durationMs: 4000, pieceOf: "T", isDeleted: true } })
    expect(await told.h["take.cut"].undo({ cuts: [{ ...cutAt1s }] })).toEqual(DONE)
    const plain = sequence({ T: { url: ORIG, trimEndMs: 1000, durationMs: 4000 }, P2: { url: ORIG, trimStartMs: 1000, durationMs: 4000, pieceOf: "T" } })
    expect(await plain.h["take.cut"].undo({ cuts: [{ ...cutAt1s }] })).toEqual(DONE)
    const three = sequence({
      T: { url: ORIG, trimEndMs: 1000, durationMs: 4000 },
      P2: { url: ORIG, trimStartMs: 1000, trimEndMs: 2000, durationMs: 4000, pieceOf: "T" },
      P3: { url: ORIG, trimStartMs: 2000, durationMs: 4000, pieceOf: "T" },
    })
    expect(await three.h["take.cut"].undo({ cuts: [{ ...cutAt1s, audioId: "P2", atMs: 2000, newAudioId: "P3" }] })).toEqual(DONE)
    expect(await three.h["take.cut"].undo({ cuts: [{ ...cutAt1s }] })).toEqual(DONE)
  })
})

// AQU-2492 (review, Nov 9), finding 7: the cut keeps the take's volume and
// fades, and the server gives them back to the joined take on Undo. Work on a
// piece's level since stops the Undo (it would be thrown away); a level change
// on the joined take since stops the Redo (the pieces would come back split
// at the old level).
describe("take.cut and the take's volume and fades (AQU-2492)", () => {
  const level = { gainDb: 6, fadeInMs: null, fadeOutMs: 500 }
  const record = (): CutRecord => ({
    cellId: "c1", audioId: "a", atMs: 1500, newAudioId: "b",
    before: { trimEndMs: null, label: "Take 1", targetOffsetMs: null, level },
    renamed: true,
  })

  it("undo joins the halves while each has the level the cut left it", async () => {
    const { ctx, handlers } = ctxFor({ a: { trimEndMs: 1500, ...level }, b: { trimStartMs: 1500, pieceOf: "a" } })
    expect(await handlers["take.cut"].undo({ cuts: [record()] })).toEqual({ kind: "done" })
    expect(ctx.uncut).toHaveBeenCalledTimes(1)
  })

  it("undo is skipped once someone changed a piece's volume or fades since", async () => {
    const first = ctxFor({ a: { trimEndMs: 1500, gainDb: -3, fadeOutMs: 500 }, b: { trimStartMs: 1500, pieceOf: "a" } })
    expect(await first.handlers["take.cut"].undo({ cuts: [record()] })).toEqual({ kind: "skipped", reason: "changed" })
    const second = ctxFor({ a: { trimEndMs: 1500, ...level }, b: { trimStartMs: 1500, pieceOf: "a", fadeOutMs: 300 } })
    expect(await second.handlers["take.cut"].undo({ cuts: [record()] })).toEqual({ kind: "skipped", reason: "changed" })
    expect(first.ctx.uncut).not.toHaveBeenCalled()
    expect(second.ctx.uncut).not.toHaveBeenCalled()
  })

  it("redo is skipped once the joined take's volume or fades changed after the Undo", async () => {
    const { ctx, handlers } = ctxFor({ a: { gainDb: -3, fadeOutMs: 800 } })
    expect(await handlers["take.cut"].redo({ cuts: [record()] })).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.cut).not.toHaveBeenCalled()
  })

  it("redo cuts again while the joined take has the level the Undo gave it back", async () => {
    const { ctx, handlers } = ctxFor({ a: { ...level } })
    expect(await handlers["take.cut"].redo({ cuts: [record()] })).toEqual({ kind: "done" })
    expect(ctx.cut).toHaveBeenCalledTimes(1)
  })

  it("a cut recorded before levels were kept checks no level", async () => {
    const old = { ...record(), before: { trimEndMs: null, label: "Take 1", targetOffsetMs: null } }
    const { ctx, handlers } = ctxFor({ a: { trimEndMs: 1500, gainDb: -3 }, b: { trimStartMs: 1500, pieceOf: "a" } })
    expect(await handlers["take.cut"].undo({ cuts: [old] })).toEqual({ kind: "done" })
    expect(ctx.uncut).toHaveBeenCalledTimes(1)
  })
})

// AQU-2492 (review, Nov 9; Sam's call the same day): "I would like an
// approved cut to still be undoable. We just need to remember the approval for
// if the cut is redone (not manually, but with a redo button)."
describe("take.cut and approvals (AQU-2492)", () => {
  const record = (validators?: string[]): CutRecord => ({
    cellId: "c1", audioId: "a", atMs: 1500, newAudioId: "b",
    before: { trimEndMs: null, label: "Take 1", targetOffsetMs: null, ...(validators ? { validators } : {}) },
    renamed: true,
  })
  const others = (takes: Takes) => (_c: string, id: string, except?: readonly string[]) =>
    ((takes[id]?.validators as string[] | undefined) ?? []).find((v) => v !== "me" && !except?.includes(v)) ?? null

  it("undo works when the pieces were approved since, and notes who approved each piece with the step", async () => {
    const takes: Takes = { a: { trimEndMs: 1500, validators: ["rosa"] }, b: { trimStartMs: 1500, pieceOf: "a", validators: ["remi", "me"] } }
    const { ctx, handlers } = ctxFor(takes, { approvedByOthers: others(takes) })
    const rec = record(["rita"])
    expect(await handlers["take.cut"].undo({ cuts: [rec] })).toEqual({ kind: "done" })
    expect(ctx.uncut).toHaveBeenCalledWith(rec)
    expect(rec.pieceVoters).toEqual({ first: ["rosa"], second: ["remi", "me"] })
    // Saved with the step after the handler runs: it lasts a reload.
    expect(JSON.parse(JSON.stringify({ cuts: [rec] })).cuts[0].pieceVoters).toEqual({ first: ["rosa"], second: ["remi", "me"] })
  })

  it("redo is not stopped by the approvals the take had before the cut (the Undo gave those back)", async () => {
    const takes: Takes = { a: { validators: ["rita", "ravi"] } }
    const { ctx, handlers } = ctxFor(takes, { approvedByOthers: others(takes) })
    expect(await handlers["take.cut"].redo({ cuts: [record(["rita", "ravi"])] })).toEqual({ kind: "done" })
    expect(ctx.cut).toHaveBeenCalledTimes(1)
  })

  it("redo notes the take's approvals as they are now: what the next Undo gives back", async () => {
    const takes: Takes = { a: { validators: ["rita", "me"] } }
    const { handlers } = ctxFor(takes, { approvedByOthers: others(takes) })
    const rec = record(["rita"])
    expect(await handlers["take.cut"].redo({ cuts: [rec] })).toEqual({ kind: "done" })
    expect(rec.before.validators).toEqual(["rita", "me"])
  })

  it("redo is skipped, naming them, when someone else approved the joined take after the Undo", async () => {
    const takes: Takes = { a: { validators: ["rita", "rafa"] } }
    const { ctx, handlers } = ctxFor(takes, { approvedByOthers: others(takes) })
    expect(await handlers["take.cut"].redo({ cuts: [record(["rita"])] })).toEqual({ kind: "skipped", reason: "approved", by: "rafa" })
    expect(ctx.cut).not.toHaveBeenCalled()
  })

  it("your own approval of the joined take does not stop the redo", async () => {
    const takes: Takes = { a: { validators: ["me"] } }
    const { handlers } = ctxFor(takes, { approvedByOthers: others(takes) })
    expect(await handlers["take.cut"].redo({ cuts: [record([])] })).toEqual({ kind: "done" })
  })

  it("redo after someone changed or deleted the take in between is skipped", async () => {
    const trimmed: Takes = { a: { trimEndMs: 5000 } }
    expect(await ctxFor(trimmed).handlers["take.cut"].redo({ cuts: [record([])] })).toEqual({ kind: "skipped", reason: "changed" })
    expect(await ctxFor({}).handlers["take.cut"].redo({ cuts: [record([])] })).toEqual({ kind: "skipped", reason: "gone" })
    // The removed piece was brought back by someone since.
    const back: Takes = { a: {}, b: { trimStartMs: 1500, pieceOf: "a" } }
    expect(await ctxFor(back).handlers["take.cut"].redo({ cuts: [record([])] })).toEqual({ kind: "skipped", reason: "changed" })
  })

  it("a cut recorded before AQU-2492 (who approved it unknown) redoes as before", async () => {
    const takes: Takes = { a: { validators: ["rafa"] } }
    const { handlers } = ctxFor(takes, { approvedByOthers: others(takes) })
    expect(await handlers["take.cut"].redo({ cuts: [record()] })).toEqual({ kind: "done" })
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

// AQU-2492 (review, Nov 9), finding 13: "Voice together" attaches one clip,
// whole, to every line; the divider editor then sets each line's slice. A
// line's slice set since is a change: its Undo is skipped, never applied over it.
describe("take.add of a Voice together clip (AQU-2492)", () => {
  const step = (cellId: string) => ({ cellId, audioId: "clip.wav", slot: "generatedVoice", selectedBefore: null, window: {} })

  it("undo takes the clip away while the line still plays all of it", async () => {
    const { ctx, handlers } = ctxFor({ "clip.wav": {} })
    expect(await handlers["take.add"].undo(step("c1"))).toEqual({ kind: "done" })
    expect(ctx.remove).toHaveBeenCalledWith("c1", "clip.wav")
  })

  it("undo is skipped as changed once the line's slice was set, and the clip stays", async () => {
    const { ctx, handlers } = ctxFor({ "clip.wav": { trimStartMs: 1200, trimEndMs: 2600 } })
    expect(await handlers["take.add"].undo(step("c1"))).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.remove).not.toHaveBeenCalled()
  })
})

// AQU-2492 (review, Nov 9), finding 4: undoing a Station Save over the
// playing whole take, on a slow network. The server holds the truth; the
// app's copy catches up only when it is read again, and choosing a take the
// copy does not list changes nothing on screen.
describe("undoing a Station Save over a take, before the app's copy catches up (AQU-2492)", () => {
  function slowLine(playing = "t2") {
    const server: { deleted: Record<string, boolean>; playing: string | null } = { deleted: { t1: true, t2: false, t3: false }, playing }
    const copy = { listed: new Set(["t2", "t3"]), playing: playing as string | null }
    const ctx: TakeStepContext = {
      readTake: (_c, id) => (copy.listed.has(id) ? ({ slot: "recording" } as CodexCellAttachment) : null),
      selectedIn: () => copy.playing,
      applyTrim: vi.fn(), applyPlace: vi.fn(), cut: vi.fn(), uncut: vi.fn(), rename: vi.fn(),
      select: vi.fn(async (_c, _s, id) => {
        if (id) server.deleted[id] = false
        server.playing = id
        if (!id || copy.listed.has(id)) copy.playing = id
      }),
      remove: vi.fn(async (_c, id) => {
        server.deleted[id] = true
        if (server.playing === id) server.playing = null
        copy.listed.delete(id)
        if (copy.playing === id) copy.playing = null
      }),
    }
    return { server, handlers: takeStepHandlers(ctx) as Record<string, StepHandler<unknown>> }
  }
  // The Save's step, as save.ts records it: the new version added, the take it replaced deleted.
  const added = { cellId: "c", audioId: "t2", slot: "recording", selectedBefore: "t1" }
  const deleted = { cellId: "c", audioId: "t1", slot: "recording", wasSelected: true, selectedBefore: "t1", replacedBy: "t2" }

  it("the old take plays again, though the app has not read it back yet", async () => {
    const { server, handlers } = slowLine()
    // A group undoes newest first: the delete, then the add.
    expect(await handlers["take.remove"].undo(deleted)).toEqual({ kind: "done" })
    expect(await handlers["take.add"].undo(added)).toEqual({ kind: "done" })
    expect(server).toEqual({ deleted: { t1: false, t2: true, t3: false }, playing: "t1" })
  })

  it("a take a colleague chose since the Save keeps the slot; the old one comes back beside it", async () => {
    const { server, handlers } = slowLine("t3")
    expect(await handlers["take.remove"].undo(deleted)).toEqual({ kind: "done" })
    expect(await handlers["take.add"].undo(added)).toEqual({ kind: "done" })
    expect(server).toEqual({ deleted: { t1: false, t2: true, t3: false }, playing: "t3" })
  })
})

// AQU-2492 (review, Nov 9), finding 9: choose Take 2 over Take 1, delete
// Take 1, then press ⌘Z twice quickly. The first Undo brings Take 1 back,
// but the app has not read it back yet; the second must still choose it.
describe("two quick Undos: chose a take, then deleted the old one (AQU-2492)", () => {
  function slowLine(noteBroughtBack: boolean) {
    const server = { deleted: { t1: true, t2: false } as Record<string, boolean>, playing: "t2" as string | null }
    const copy = { listed: new Set(["t2"]), playing: "t2" as string | null }
    const broughtBack = new Set<string>()
    const ctx: TakeStepContext = {
      readTake: (_c, id) => (copy.listed.has(id) ? ({ slot: "recording" } as CodexCellAttachment) : null),
      selectedIn: () => copy.playing,
      applyTrim: vi.fn(), applyPlace: vi.fn(), cut: vi.fn(), uncut: vi.fn(), rename: vi.fn(), remove: vi.fn(),
      select: vi.fn(async (_c, _s, id) => {
        if (id && server.deleted[id]) broughtBack.add(id)
        if (id) server.deleted[id] = false
        server.playing = id
        if (!id || copy.listed.has(id)) copy.playing = id
      }),
      ...(noteBroughtBack ? { broughtBack: (_c: string, id: string) => broughtBack.has(id) } : {}),
    }
    return { server, handlers: takeStepHandlers(ctx) as Record<string, StepHandler<unknown>> }
  }
  const chose = { cellId: "c", slot: "recording", before: "t1", after: "t2" }
  const deleted = { cellId: "c", audioId: "t1", slot: "recording", wasSelected: false, selectedBefore: null }

  it("the second Undo chooses the take the first brought back, and Take 1 plays", async () => {
    const { server, handlers } = slowLine(true)
    expect(await handlers["take.remove"].undo(deleted)).toEqual({ kind: "done" })
    expect(await handlers["take.select"].undo(chose)).toEqual({ kind: "done" })
    expect(server).toEqual({ deleted: { t1: false, t2: false }, playing: "t1" })
  })

  it("a take deleted by someone else, never brought back here, is still left alone", async () => {
    const { server, handlers } = slowLine(true)
    expect(await handlers["take.select"].undo(chose)).toEqual({ kind: "skipped", reason: "gone" })
    expect(server.playing).toBe("t2")
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

// AQU-2492 (review, Nov 9), finding 6: Undo never brings back a take a
// colleague deleted, and a cut take with its first piece deleted is still a
// take. Choosing a deleted take is how the server un-deletes one, so an Undo
// that went back to "the take that played before" quietly reversed someone's
// delete. And a cut take is named by its first piece: with that piece deleted
// the step read the whole take as gone and left the line playing nothing.
describe("going back to a take that was deleted since (AQU-2492)", () => {
  const group = (takes: Takes) => (_c: string, id: string) =>
    Object.keys(takes).filter((k) => !takes[k].isDeleted && (takes[k].pieceOf ?? k) === (takes[id]?.pieceOf ?? id))

  it("undoing 'chose a take' is skipped when the take to go back to was deleted, and nothing is chosen", async () => {
    const takes: Takes = { a: { isDeleted: true }, b: {} }
    const { ctx, handlers } = ctxFor(takes, { selectedIn: () => "b", liveGroup: group(takes) })
    const data = { cellId: "c", slot: "recording", before: "a", after: "b" }
    expect(await handlers["take.select"].undo(data)).toEqual({ kind: "skipped", reason: "gone" })
    expect(ctx.select).not.toHaveBeenCalled()
  })

  it("…and on an added track, the same", async () => {
    const takes: Takes = { a: { isDeleted: true, slot: "track-9" }, b: { slot: "track-9" } }
    const { ctx, handlers } = ctxFor(takes, { selectedIn: (_c, slot) => (slot === "track-9" ? "b" : null), liveGroup: group(takes) })
    expect(await handlers["take.select"].undo({ cellId: "c", slot: "track-9", before: "a", after: "b" })).toEqual({ kind: "skipped", reason: "gone" })
    expect(ctx.select).not.toHaveBeenCalled()
  })

  it("a cut take whose first piece was deleted is chosen again by a piece that is left", async () => {
    const takes: Takes = { a: { isDeleted: true }, a2: { pieceOf: "a" }, a3: { pieceOf: "a" }, b: {} }
    const { ctx, handlers } = ctxFor(takes, { selectedIn: () => "b", liveGroup: group(takes) })
    expect(await handlers["take.select"].undo({ cellId: "c", slot: "recording", before: "a", after: "b" })).toEqual({ kind: "done" })
    // Never the deleted first piece: choosing it would bring it back.
    expect(ctx.select).toHaveBeenCalledTimes(1)
    expect(ctx.select).toHaveBeenCalledWith("c", "recording", "a2")
  })

  it("redoing 'chose a take' chooses a piece that is left, and is skipped as gone when none is", async () => {
    const takes: Takes = { a: {}, b: { isDeleted: true }, b2: { pieceOf: "b" } }
    const { ctx, handlers } = ctxFor(takes, { selectedIn: () => "a", liveGroup: group(takes) })
    const data = { cellId: "c", slot: "recording", before: "a", after: "b" }
    expect(await handlers["take.select"].redo(data)).toEqual({ kind: "done" })
    expect(ctx.select).toHaveBeenCalledWith("c", "recording", "b2")
    takes.b2 = { pieceOf: "b", isDeleted: true }
    expect(await handlers["take.select"].redo(data)).toEqual({ kind: "skipped", reason: "gone" })
    expect(ctx.select).toHaveBeenCalledTimes(1)
  })

  it("undoing a new recording plays the cut take's remaining pieces again", async () => {
    const takes: Takes = { old: { isDeleted: true, slot: "recording" }, old2: { pieceOf: "old", slot: "recording" }, new: { slot: "recording" } }
    const playing = { id: "new" as string | null }
    const { ctx, handlers } = ctxFor(takes, {
      selectedIn: () => playing.id,
      remove: vi.fn(async (_c, id) => { takes[id] = { ...takes[id], isDeleted: true } }),
      select: vi.fn(async (_c, _s, id) => { playing.id = id }),
      liveGroup: group(takes),
    })
    const added = { cellId: "c", audioId: "new", slot: "recording", selectedBefore: "old" }
    expect(await handlers["take.add"].undo(added)).toEqual({ kind: "done" })
    expect(ctx.select).toHaveBeenCalledWith("c", "recording", "old2")
  })

  it("undoing a new recording leaves the slot empty when the take that played before was deleted whole", async () => {
    const takes: Takes = { old: { isDeleted: true }, new: {} }
    const { ctx, handlers } = ctxFor(takes, {
      selectedIn: () => "new",
      remove: vi.fn(async (_c, id) => { takes[id] = { ...takes[id], isDeleted: true } }),
      liveGroup: group(takes),
    })
    expect(await handlers["take.add"].undo({ cellId: "c", audioId: "new", slot: "recording", selectedBefore: "old" })).toEqual({ kind: "done" })
    expect(ctx.select).not.toHaveBeenCalled()
  })
})

// AQU-2492 (review, Nov 9), finding 7: undoing a delete brings the take BACK;
// it only makes it the one that plays when nothing else has taken its place.
// And redoing a delete does not remove a take someone approved in between.
describe("undoing and redoing a delete (AQU-2492)", () => {
  /** A line whose `slot` plays `playing.id`; select and remove update it, as the server would. */
  function line(takes: Takes, playing: { id: string | null }, slot = "recording") {
    const groupOf = (id: string) => takes[id]?.pieceOf ?? id
    return ctxFor(takes, {
      selectedIn: (_c, s) => (s === slot ? playing.id : null),
      remove: vi.fn(async (_c, id) => {
        takes[id] = { ...takes[id], isDeleted: true }
        const left = Object.keys(takes).some((k) => !takes[k].isDeleted && groupOf(k) === groupOf(id))
        if (playing.id === groupOf(id) && !left) playing.id = null
      }),
      select: vi.fn(async (_c, _s, id) => {
        if (id) takes[id] = { ...takes[id], isDeleted: false }
        playing.id = id ? groupOf(id) : null
      }),
      approvedByOthers: (_c, id, except) => (takes[id]?.validators ?? []).find((v) => v !== "asha" && !except?.includes(v)) ?? null,
      liveGroup: (_c, id) => Object.keys(takes).filter((k) => !takes[k].isDeleted && groupOf(k) === groupOf(id)),
    })
  }
  const removed = { cellId: "c", audioId: "take1", slot: "recording", wasSelected: true, selectedBefore: null }

  it("the take plays again when nothing has taken its place", async () => {
    const takes: Takes = { take1: { isDeleted: true } }
    const playing = { id: null as string | null }
    const { ctx, handlers } = line(takes, playing)
    expect(await handlers["take.remove"].undo(removed)).toEqual({ kind: "done" })
    expect(takes.take1.isDeleted).toBe(false)
    expect(playing.id).toBe("take1")
    expect(ctx.select).toHaveBeenCalledTimes(1)
  })

  it("a take a colleague recorded since keeps playing; the deleted one comes back beside it", async () => {
    const takes: Takes = { take1: { isDeleted: true }, take9: {} }
    const playing = { id: "take9" as string | null }
    const { handlers } = line(takes, playing)
    expect(await handlers["take.remove"].undo(removed)).toEqual({ kind: "done" })
    expect(takes.take1.isDeleted).toBe(false)
    expect(playing.id).toBe("take9")
  })

  it("the same on an added track", async () => {
    const takes: Takes = { take1: { isDeleted: true, slot: "track-9" }, take9: { slot: "track-9" } }
    const playing = { id: "take9" as string | null }
    const { handlers } = line(takes, playing, "track-9")
    expect(await handlers["take.remove"].undo({ ...removed, slot: "track-9" })).toEqual({ kind: "done" })
    expect(takes.take1.isDeleted).toBe(false)
    expect(playing.id).toBe("take9")
  })

  it("a cut take deleted whole comes back, every piece, without taking the slot from a take chosen since", async () => {
    const takes: Takes = { take1: { isDeleted: true }, p2: { isDeleted: true, pieceOf: "take1" }, take9: {} }
    const playing = { id: "take9" as string | null }
    const { handlers } = line(takes, playing)
    expect(await handlers["take.remove"].undo({ ...removed, pieces: ["p2"] })).toEqual({ kind: "done" })
    expect(takes.take1.isDeleted).toBe(false)
    expect(takes.p2.isDeleted).toBe(false)
    expect(playing.id).toBe("take9")
  })

  it("one piece of the playing cut take comes back and the take keeps playing", async () => {
    const takes: Takes = { take1: {}, p2: { isDeleted: true, pieceOf: "take1" } }
    const playing = { id: "take1" as string | null }
    const { ctx, handlers } = line(takes, playing)
    expect(await handlers["take.remove"].undo({ ...removed, audioId: "p2" })).toEqual({ kind: "done" })
    expect(takes.p2.isDeleted).toBe(false)
    expect(playing.id).toBe("take1")
    // Giving the slot back never names a deleted take.
    for (const [, , id] of (ctx.select as ReturnType<typeof vi.fn>).mock.calls) expect(["take1", "p2"]).toContain(id)
  })

  it("the cut take that plays now has lost its first piece: the slot goes back to a piece that is left", async () => {
    const takes: Takes = { take1: { isDeleted: true }, other: { isDeleted: true }, o2: { pieceOf: "other" } }
    const playing = { id: "other" as string | null }
    const { ctx, handlers } = line(takes, playing)
    expect(await handlers["take.remove"].undo(removed)).toEqual({ kind: "done" })
    expect(playing.id).toBe("other")
    expect(takes.other.isDeleted).toBe(true)
    expect(ctx.select).toHaveBeenLastCalledWith("c", "recording", "o2")
  })

  it("a take that was not playing comes back and the slot stays empty", async () => {
    const takes: Takes = { take1: { isDeleted: true } }
    const playing = { id: null as string | null }
    const { handlers } = line(takes, playing)
    expect(await handlers["take.remove"].undo({ ...removed, wasSelected: false })).toEqual({ kind: "done" })
    expect(takes.take1.isDeleted).toBe(false)
    expect(playing.id).toBeNull()
  })

  it("redo is skipped, naming them, once someone else approved the take in between", async () => {
    const takes: Takes = { take1: { validators: ["asha", "ben"] } }
    const { ctx, handlers } = line(takes, { id: "take1" })
    expect(await handlers["take.remove"].redo({ ...removed, approvedBy: { take1: ["asha"] } })).toEqual({ kind: "skipped", reason: "approved", by: "ben" })
    expect(ctx.remove).not.toHaveBeenCalled()
  })

  it("…also when it is a piece of a cut take that they approved", async () => {
    const takes: Takes = { take1: {}, p2: { pieceOf: "take1", validators: ["ben"] } }
    const { ctx, handlers } = line(takes, { id: "take1" })
    expect(await handlers["take.remove"].redo({ ...removed, pieces: ["p2"], approvedBy: { take1: [], p2: [] } })).toEqual({ kind: "skipped", reason: "approved", by: "ben" })
    expect(ctx.remove).not.toHaveBeenCalled()
  })

  // AQU-2492 (review, Nov 9), finding 8: the Undo gave the take back WITH
  // the approvals it had when it was deleted. Only an approval given since
  // stops the Redo, the same rule as the cut's.
  it("an approval the take had before it was deleted does not stop the Redo", async () => {
    const takes: Takes = { take1: { validators: ["ben"] } }
    const { ctx, handlers } = line(takes, { id: "take1" })
    expect(await handlers["take.remove"].redo({ ...removed, approvedBy: { take1: ["ben"] } })).toEqual({ kind: "done" })
    expect(ctx.remove).toHaveBeenCalledWith("c", "take1")
  })

  it("…but one given after the Undo, beside it, does", async () => {
    const takes: Takes = { take1: { validators: ["ben", "cal"] } }
    const { ctx, handlers } = line(takes, { id: "take1" })
    expect(await handlers["take.remove"].redo({ ...removed, approvedBy: { take1: ["ben"] } })).toEqual({ kind: "skipped", reason: "approved", by: "cal" })
    expect(ctx.remove).not.toHaveBeenCalled()
  })

  it("…piece by piece for a cut take", async () => {
    const takes: Takes = { take1: { validators: ["ben"] }, p2: { pieceOf: "take1", validators: ["remi"] } }
    const { ctx, handlers } = line(takes, { id: "take1" })
    expect(await handlers["take.remove"].redo({ ...removed, pieces: ["p2"], approvedBy: { take1: ["ben"], p2: ["remi"] } })).toEqual({ kind: "done" })
    expect(ctx.remove).toHaveBeenCalledTimes(2)
  })

  it("a delete recorded before it (who had approved it unknown) redoes as before", async () => {
    const takes: Takes = { take1: { validators: ["ben"] } }
    const { ctx, handlers } = line(takes, { id: "take1" })
    expect(await handlers["take.remove"].redo(removed)).toEqual({ kind: "done" })
    expect(ctx.remove).toHaveBeenCalledWith("c", "take1")
  })

  it("your own approval does not stop your Redo", async () => {
    const takes: Takes = { take1: { validators: ["asha"] } }
    const { ctx, handlers } = line(takes, { id: "take1" })
    expect(await handlers["take.remove"].redo(removed)).toEqual({ kind: "done" })
    expect(ctx.remove).toHaveBeenCalledWith("c", "take1")
  })
})

// AQU-2492 (review, Nov 9), finding 14: holding an arrow key on a Recording-
// tab trim line saves on every key repeat. A run of window changes on one
// take, close together, is ONE step — as a timeline drag is — not one per
// repeat pushing older steps out of the history.
describe("a run of trim nudges is one step (AQU-2492)", () => {
  beforeEach(async () => {
    resetHistoryForTests()
    await clearHistoryStoreForTests()
    setHistoryScope("p1", "sam")
    await historyReady()
  })
  const nudge = (audioId: string, fromEnd: number, toEnd: number, at: number) =>
    recordTakeWindowRun({ cellId: "c1", audioId, before: { trimEndMs: fromEnd }, after: { trimEndMs: toEnd } }, { fileId: "f1" }, at)

  it("ninety repeats of a held key make one step, from where the run started to where it ended", () => {
    recordStep({ kind: "test.older", data: {}, labelKey: "older" })
    for (let i = 0; i < 90; i++) nudge("a", 3000 - i * 10, 3000 - (i + 1) * 10, 1_000 + i * 33)
    const undo = matchingSteps((kind) => kind === "take.window").undo
    expect(undo).toHaveLength(1)
    const data = matchingSteps((kind, d) => kind === "take.window" && (d as { before: { trimEndMs: number }; after: { trimEndMs: number } }).before.trimEndMs === 3000 && (d as { after: { trimEndMs: number } }).after.trimEndMs === 2100)
    expect(data.undo).toHaveLength(1)
    expect(historyView().undoSteps.map((s) => s.labelKey)).toEqual(["older", "editor.history.stepTrim"])
  })

  it("a pause, another take, or an Undo in between starts a new step", async () => {
    nudge("a", 3000, 2990, 1_000)
    nudge("a", 2990, 2980, 3_500) // after a pause
    nudge("b", 1000, 990, 3_600) // another take
    expect(matchingSteps((kind) => kind === "take.window").undo).toHaveLength(3)
    registerStepKinds({ "take.window": { undo: async () => ({ kind: "done" }), redo: async () => ({ kind: "done" }) } as StepHandler<never> })
    await undoLast()
    nudge("b", 1000, 990, 3_700) // right after the Undo: a step of its own
    expect(matchingSteps((kind) => kind === "take.window").undo).toHaveLength(3)
    expect(matchingSteps((kind) => kind === "take.window").redo).toHaveLength(0)
  })
})
