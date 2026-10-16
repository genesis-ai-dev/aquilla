// AQU-1767 phase 2: undo/redo of rows, text, votes, settings and tracks, each
// with its "changed since" guard.
import { describe, it, expect, vi } from "vitest"
import { rowStepHandlers, type RowState, type RowStepContext } from "./row-steps"
import { editStepHandlers, type EditStepContext } from "./edit-steps"
import { trackStepHandlers, trackFieldsOf, type TrackFields, type TrackStepContext } from "./track-steps"
import type { StepHandler } from "./history"

const as = (h: Record<string, StepHandler<never>>) => h as unknown as Record<string, StepHandler<unknown>>

describe("rows", () => {
  function rows(initial: Record<string, RowState>, over: Partial<RowStepContext> = {}) {
    const state = { ...initial }
    const ctx: RowStepContext = {
      readRow: (id) => state[id] ?? null,
      retime: vi.fn(async (id, _m, timing) => { state[id] = { ...state[id], timing } }),
      setHidden: vi.fn(async (id, hidden) => { state[id] = { ...state[id], hidden } }),
      remove: vi.fn(async (id) => {
        delete state[id]
        return { successor: { cellId: "next", anchorAfter: "prev" } }
      }),
      restore: vi.fn(async (id) => {
        state[id] = { hidden: false, timing: null, anchorCellId: "prev", hasWork: true }
        return true
      }),
      repoint: vi.fn(async (id, anchor) => { state[id] = { ...state[id], anchorCellId: anchor } }),
      ...over,
    }
    return { state, ctx, h: as(rowStepHandlers(ctx)) }
  }
  const row = (o: Partial<RowState> = {}): RowState => ({ hidden: false, timing: null, anchorCellId: null, hasWork: false, ...o })

  it("a retime goes back while the row still has the new timing", async () => {
    const { ctx, h, state } = rows({ c: row({ timing: { startMs: 10, endMs: 20 } }) })
    const d = { cellId: "c", mode: "text", before: { startMs: 0, endMs: 10 }, after: { startMs: 10, endMs: 20 } }
    expect(await h["row.retime"].undo(d)).toEqual({ kind: "done" })
    expect(state.c.timing).toEqual({ startMs: 0, endMs: 10 })
    state.c = row({ timing: { startMs: 5, endMs: 9 } })
    expect(await h["row.retime"].redo(d)).toEqual({ kind: "skipped", reason: "changed" })
    expect(ctx.retime).toHaveBeenCalledTimes(1)
  })

  it("hide and show flip each other", async () => {
    const { h, state } = rows({ c: row({ hidden: true }) })
    expect(await h["row.hidden"].undo({ cellId: "c", hidden: true })).toEqual({ kind: "done" })
    expect(state.c.hidden).toBe(false)
    expect(await h["row.hidden"].redo({ cellId: "c", hidden: true })).toEqual({ kind: "done" })
    expect(state.c.hidden).toBe(true)
  })

  it("undoing a removal restores the row and points its old successor back at it", async () => {
    const { ctx, h, state } = rows({ next: row({ anchorCellId: "prev" }) })
    const d = { cellId: "c", successor: { cellId: "next", anchorAfter: "prev" } }
    expect(await h["row.remove"].undo(d)).toEqual({ kind: "done" })
    expect(ctx.restore).toHaveBeenCalledWith("c")
    expect(ctx.repoint).toHaveBeenCalledWith("next", "c")
    expect(state.next.anchorCellId).toBe("c")
  })

  it("a successor somebody moved since keeps its new place", async () => {
    const { ctx, h } = rows({ next: row({ anchorCellId: "elsewhere" }) })
    expect(await h["row.remove"].undo({ cellId: "c", successor: { cellId: "next", anchorAfter: "prev" } })).toEqual({ kind: "done" })
    expect(ctx.repoint).not.toHaveBeenCalled()
  })

  it("undoing a removal is skipped when the row is already back, or the server refuses", async () => {
    const back = rows({ c: row() })
    expect(await back.h["row.remove"].undo({ cellId: "c", successor: null })).toEqual({ kind: "skipped", reason: "changed" })
    const refused = rows({}, { restore: vi.fn(async () => false) })
    expect(await refused.h["row.remove"].undo({ cellId: "c", successor: null })).toEqual({ kind: "skipped", reason: "gone" })
  })

  it("redoing a removal removes it again and remembers the new successor", async () => {
    const { h } = rows({ c: row() })
    const d = { cellId: "c", successor: null as null | { cellId: string; anchorAfter: string | null } }
    expect(await h["row.remove"].redo(d)).toEqual({ kind: "done" })
    expect(d.successor).toEqual({ cellId: "next", anchorAfter: "prev" })
  })

  it("an added row is removed again only while nobody has written in it", async () => {
    const empty = rows({ c: row() })
    expect(await empty.h["row.add"].undo({ cellId: "c" })).toEqual({ kind: "done" })
    const worked = rows({ c: row({ hasWork: true }) })
    expect(await worked.h["row.add"].undo({ cellId: "c" })).toEqual({ kind: "skipped", reason: "changed" })
    expect(worked.ctx.remove).not.toHaveBeenCalled()
    // Redo of that undo brings the same row back (restore keeps its id).
    expect(await empty.h["row.add"].redo({ cellId: "c" })).toEqual({ kind: "done" })
    expect(empty.ctx.restore).toHaveBeenCalledWith("c")
  })
})

describe("text, votes, settings", () => {
  function edits(over: Partial<EditStepContext> = {}) {
    const ctx: EditStepContext = {
      readText: () => ({ value: "after" }),
      commitText: vi.fn(async () => {}),
      readTextVote: () => ({ editEventId: "e1", voted: true }),
      setTextVote: vi.fn(async () => {}),
      readAudioVote: () => true,
      setAudioVote: vi.fn(async () => {}),
      readSettings: () => ({ validationCount: 2, timingLocked: false }),
      writeSettings: vi.fn(async () => {}),
      ...over,
    }
    return { ctx, h: as(editStepHandlers(ctx)) }
  }

  it("a committed edit goes back to the previous text while the cell still holds the edit", async () => {
    const { ctx, h } = edits()
    const d = { cellId: "c", lane: "", side: "target", before: { value: "before" }, after: { value: "after" } }
    expect(await h["text.commit"].undo(d)).toEqual({ kind: "done" })
    expect(ctx.commitText).toHaveBeenCalledWith("c", "target", "", { value: "before" })
    const changed = edits({ readText: () => ({ value: "someone else's" }) })
    expect(await changed.h["text.commit"].undo(d)).toEqual({ kind: "skipped", reason: "changed" })
  })

  it("your vote flips back only on the translation you voted on", async () => {
    const { ctx, h } = edits()
    expect(await h["vote.text"].undo({ cellId: "c", lane: "", voted: true, editEventId: "e1" })).toEqual({ kind: "done" })
    expect(ctx.setTextVote).toHaveBeenCalledWith("c", "", "e1", false)
    const edited = edits({ readTextVote: () => ({ editEventId: "e2", voted: false }) })
    expect(await edited.h["vote.text"].undo({ cellId: "c", lane: "", voted: true, editEventId: "e1" })).toEqual({
      kind: "skipped",
      reason: "changed",
    })
  })

  it("an audio vote flips back while it is still as you left it", async () => {
    const { ctx, h } = edits()
    expect(await h["vote.audio"].undo({ cellId: "c", audioId: "a", voted: true })).toEqual({ kind: "done" })
    expect(ctx.setAudioVote).toHaveBeenCalledWith("c", "a", false)
    const gone = edits({ readAudioVote: () => null })
    expect(await gone.h["vote.audio"].undo({ cellId: "c", audioId: "a", voted: true })).toEqual({ kind: "skipped", reason: "gone" })
  })

  it("a settings save goes back setting by setting; one changed since keeps its new value", async () => {
    const { ctx, h } = edits({ readSettings: () => ({ validationCount: 2, timingLocked: true }) })
    const d = {
      changes: [
        { key: "validationCount", before: 1, after: 2 },
        { key: "timingLocked", before: true, after: false }, // somebody locked it again since
      ],
    }
    expect(await h["settings.project"].undo(d)).toEqual({ kind: "done", partial: { skipped: 1 } })
    expect(ctx.writeSettings).toHaveBeenCalledWith({ validationCount: 1 })
  })
})

describe("tracks", () => {
  function tracks(initial: Record<string, TrackFields>) {
    const state: Record<string, TrackFields> = { ...initial }
    const ctx: TrackStepContext = {
      readTrack: (id) => state[id] ?? null,
      patchTracks: vi.fn(async (changes) => {
        for (const c of changes) {
          if (c.patch === null) delete state[c.trackId]
          else state[c.trackId] = { ...(state[c.trackId] ?? {}), ...c.patch }
        }
      }),
      restoreTakes: vi.fn(async () => {}),
      removeTakes: vi.fn(async () => {}),
    }
    return { state, ctx, h: as(trackStepHandlers(ctx)) }
  }

  it("a rename goes back field by field", async () => {
    const { h, state } = tracks({ t1: { kind: "audio", name: "Dub", order: 0 } })
    const d = { changes: [{ trackId: "t1", before: { name: "Track 2" }, after: { name: "Dub" } }] }
    expect(await h["track.patch"].undo(d)).toEqual({ kind: "done" })
    expect(state.t1.name).toBe("Track 2")
  })

  it("an added folder and its members go back together; a later change skips the whole step", async () => {
    const { h, state } = tracks({
      f: { kind: "folder", name: "Folder", order: 3 },
      a: { kind: "audio", name: "A", order: 0, groupId: "f" },
    })
    const d = {
      changes: [
        { trackId: "f", before: null, after: { kind: "folder", name: "Folder", order: 3 } },
        { trackId: "a", before: { groupId: null, order: 3 }, after: { groupId: "f", order: 0 } },
      ],
    }
    expect(await h["track.patch"].undo(d)).toEqual({ kind: "done" })
    expect(state.f).toBeUndefined()
    expect(state.a).toMatchObject({ groupId: null, order: 3 })
    state.a = { ...state.a, order: 9 } // somebody moved it since
    expect(await h["track.patch"].redo(d)).toEqual({ kind: "skipped", reason: "changed" })
  })

  it("undoing a delete brings the track back, then its recordings", async () => {
    const { ctx, h, state } = tracks({})
    const takes = [{ cellId: "c", audioId: "x", fileId: "f", slot: "t1", wasSelected: true }]
    const d = {
      changes: [{ trackId: "t1", before: { kind: "audio", name: "Dub", order: 1, groupId: null }, after: null }],
      takes,
    }
    expect(await h["track.patch"].undo(d)).toEqual({ kind: "done" })
    expect(state.t1).toMatchObject({ kind: "audio", name: "Dub", order: 1 })
    expect(ctx.restoreTakes).toHaveBeenCalledWith(takes)
    expect(await h["track.patch"].redo(d)).toEqual({ kind: "done" })
    expect(state.t1).toBeUndefined()
    expect(ctx.removeTakes).toHaveBeenCalledWith(takes)
  })

  it("trackFieldsOf narrows to the fields a verb wrote", () => {
    const track = { id: "t", kind: "audio", name: "Dub", order: 2, color: "amber" }
    expect(trackFieldsOf(track, ["color"])).toEqual({ color: "amber" })
    expect(trackFieldsOf(track)).toMatchObject({ kind: "audio", name: "Dub", order: 2, groupId: null })
  })
})
