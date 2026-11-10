// AQU-2492 (review, Nov 9): a track change can be undone straight away.
//
// The "changed since?" guard read the last SETTLED track list. A change is
// written first and read back later (seconds on a hotspot), so ⌘Z pressed
// straight after deleting a track still saw the track, called the step
// "changed since" and dropped it for good — and a new track gets a new id, so
// the deleted track's recordings could not be reached again. The same lost
// the Undo of a quick rename, reorder, colour or "Sets line lengths" change.
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  noteTrackWrite,
  TrackWriteNotes,
  trackNow,
  trackStepHandlers,
  type PendingTrack,
  type TrackFields,
  type TrackStepData,
  type TrackTake,
} from "./track-steps"
import type { StepOutcome } from "./history"

const VOICE: TrackFields = {
  kind: "audio", name: "Narrator", order: 3, groupId: null, color: "violet",
  sourceTrackId: null, contentFileId: null, setsLineLengths: null,
}
const TAKES: TrackTake[] = [
  { cellId: "c1", audioId: "a1", fileId: "f1", slot: "track-9", wasSelected: true },
  { cellId: "c2", audioId: "a2", fileId: "f1", slot: "track-9", wasSelected: false },
]

/**
 * The workspace as far as these steps see it: `read` is the project read (what
 * the server last ANSWERED); a write lands on the server at once and is noted
 * as pending; `answer()` is the read catching up.
 */
function workspace(initial: Record<string, TrackFields>, opts: { remember: boolean }) {
  const server = new Map<string, TrackFields>(Object.entries(initial))
  let read = new Map(server)
  const pending = new Map<string, PendingTrack>()
  const restoreTakes = vi.fn(async (_t: readonly TrackTake[]) => {})
  const removeTakes = vi.fn(async (_t: readonly TrackTake[]) => {})
  const readTrack = (trackId: string): TrackFields | null => {
    const now = trackNow(read.get(trackId) ?? null, pending.get(trackId))
    if (now.pending) pending.set(trackId, now.pending)
    else pending.delete(trackId)
    return now.track
  }
  const write = (trackId: string, patch: TrackFields | null) => {
    if (opts.remember) pending.set(trackId, noteTrackWrite(read.get(trackId) ?? null, pending.get(trackId), patch))
    if (patch === null) server.delete(trackId)
    else server.set(trackId, { ...(server.get(trackId) ?? {}), ...patch })
  }
  const handlers = trackStepHandlers({
    readTrack,
    patchTracks: async (changes) => { for (const c of changes) write(c.trackId, c.patch) },
    restoreTakes,
    removeTakes,
  })
  const step = handlers["track.patch"] as unknown as {
    undo(d: TrackStepData): Promise<StepOutcome>
    redo(d: TrackStepData): Promise<StepOutcome>
  }
  return {
    server, readTrack, write, restoreTakes, removeTakes,
    undo: (d: TrackStepData) => step.undo(d),
    redo: (d: TrackStepData) => step.redo(d),
    /** The project read comes back with what the server holds now. */
    answer: () => { read = new Map(server) },
    /** …or with what it held when an older request was made. */
    answerWith: (snapshot: Map<string, TrackFields>) => { read = new Map(snapshot) },
  }
}

const deleted = (): TrackStepData => ({ changes: [{ trackId: "t9", before: { ...VOICE }, after: null }], takes: TAKES })

describe("undoing a track change before the project read comes back (AQU-2492)", () => {
  let ws: ReturnType<typeof workspace>
  beforeEach(() => { ws = workspace({ t9: VOICE }, { remember: true }) })

  it("a deleted track comes back, with its recordings", async () => {
    ws.write("t9", null)
    // ⌘Z before the read answers: the read still shows the track.
    expect(await ws.undo(deleted())).toEqual({ kind: "done" })
    expect(ws.server.get("t9")).toMatchObject({ name: "Narrator", order: 3, color: "violet" })
    expect(ws.restoreTakes).toHaveBeenCalledWith(TAKES)
  })

  it("…and Redo straight after deletes it again, then Undo brings it back again", async () => {
    ws.write("t9", null)
    const d = deleted()
    expect(await ws.undo(d)).toEqual({ kind: "done" })
    expect(await ws.redo(d)).toEqual({ kind: "done" })
    expect(ws.server.has("t9")).toBe(false)
    expect(ws.removeTakes).toHaveBeenCalledWith(TAKES)
    expect(await ws.undo(d)).toEqual({ kind: "done" })
    expect(ws.server.has("t9")).toBe(true)
  })

  it("a read that answers the DELETE while the Undo is still on its way doesn't lose the Redo", async () => {
    ws.write("t9", null)
    const afterDelete = new Map(ws.server)
    const d = deleted()
    expect(await ws.undo(d)).toEqual({ kind: "done" })
    ws.answerWith(afterDelete) // the delete's own refresh lands late
    expect(ws.readTrack("t9")).toMatchObject({ name: "Narrator" })
    expect(await ws.redo(d)).toEqual({ kind: "done" })
  })

  it("a quick rename, reorder, colour or 'Sets line lengths' change can be undone too", async () => {
    for (const [after, before] of [
      [{ name: "Ruth" }, { name: "Narrator" }],
      [{ order: 7 }, { order: 3 }],
      [{ color: "teal" }, { color: "violet" }],
      [{ setsLineLengths: false }, { setsLineLengths: null }],
    ] as Array<[TrackFields, TrackFields]>) {
      ws = workspace({ t9: VOICE }, { remember: true })
      ws.write("t9", after)
      expect(await ws.undo({ changes: [{ trackId: "t9", before, after }] })).toEqual({ kind: "done" })
      expect(ws.server.get("t9")).toMatchObject(before)
    }
  })

  it("two quick renames: the second step's Undo goes back to the first name, not the one before it", async () => {
    ws.write("t9", { name: "Ruth" })
    // What the workspace records as the second rename's "before".
    expect(ws.readTrack("t9")).toMatchObject({ name: "Ruth" })
    ws.write("t9", { name: "Naomi" })
    expect(await ws.undo({ changes: [{ trackId: "t9", before: { name: "Ruth" }, after: { name: "Naomi" } }] })).toEqual({ kind: "done" })
    expect(await ws.undo({ changes: [{ trackId: "t9", before: { name: "Narrator" }, after: { name: "Ruth" } }] })).toEqual({ kind: "done" })
    expect(ws.server.get("t9")).toMatchObject({ name: "Narrator" })
  })

  it("a colleague's change that the read brings back still stops the Undo", async () => {
    ws.write("t9", { name: "Ruth" })
    ws.server.set("t9", { ...VOICE, name: "Boaz" }) // someone else renamed it after us
    ws.answer()
    expect(await ws.undo({ changes: [{ trackId: "t9", before: { name: "Narrator" }, after: { name: "Ruth" } }] }))
      .toEqual({ kind: "skipped", reason: "changed" })
    expect(ws.server.get("t9")).toMatchObject({ name: "Boaz" })
  })

  it("once the read has caught up, nothing is remembered", async () => {
    ws.write("t9", { name: "Ruth" })
    ws.answer()
    expect(ws.readTrack("t9")).toMatchObject({ name: "Ruth" })
    expect(trackNow({ ...VOICE, name: "Ruth" }, undefined)).toEqual({ track: { ...VOICE, name: "Ruth" }, pending: undefined })
  })

  // The shape this replaces, pinned so nobody reaches for it again.
  it("(why) checked against the settled read alone, the Undo is skipped and the track is gone for good", async () => {
    ws = workspace({ t9: VOICE }, { remember: false })
    ws.write("t9", null)
    expect(await ws.undo(deleted())).toEqual({ kind: "skipped", reason: "changed" })
    expect(ws.server.has("t9")).toBe(false)
    expect(ws.restoreTakes).not.toHaveBeenCalled()
  })
})

// AQU-2492 (review, Nov 9), finding 10: the built-in rows (the main
// Recordings row and its kin) have the same ids in every file, and the
// workspace stays open across files. A change written in chapter 1 must not
// be read as the same row's state in chapter 2: a step belongs to the file
// and chapter it was made in.
describe("track notes belong to the file they were written in (AQU-2492)", () => {
  const ROW = "recording"
  it("a colour written in chapter 1 is not chapter 2's row, so chapter 2's Undo puts back no colour", async () => {
    const settled: Record<string, TrackFields> = {
      ch1: { kind: "audio", name: "Recordings", color: null },
      ch2: { kind: "audio", name: "Recordings", color: null },
    }
    const notes = new TrackWriteNotes()
    let open = "ch1"
    const readTrack = (trackId: string) => notes.read(open, trackId, settled[open] ?? null)
    // Chapter 1: recolour the main row teal (the read has not caught up).
    notes.note("ch1", ROW, settled.ch1, { color: "teal" })
    expect(readTrack(ROW)).toMatchObject({ color: "teal" })
    // Chapter 2: the same row, as chapter 2 has it, is recoloured violet.
    open = "ch2"
    const before = readTrack(ROW)
    expect(before).toMatchObject({ color: null })
    notes.note("ch2", ROW, settled.ch2, { color: "violet" })
    const patched: Array<{ trackId: string; patch: TrackFields | null }> = []
    const handlers = trackStepHandlers({
      readTrack,
      patchTracks: async (changes) => { patched.push(...changes) },
      restoreTakes: vi.fn(),
      removeTakes: vi.fn(),
    }) as unknown as Record<string, { undo(d: TrackStepData): Promise<StepOutcome> }>
    const step: TrackStepData = { changes: [{ trackId: ROW, before: { color: before?.color ?? null }, after: { color: "violet" } }] }
    expect(await handlers["track.patch"].undo(step)).toEqual({ kind: "done" })
    expect(patched).toEqual([{ trackId: ROW, patch: { color: null } }])
    // And chapter 1 still has its own note when the person goes back.
    open = "ch1"
    expect(readTrack(ROW)).toMatchObject({ color: "teal" })
  })

  it("forgetting a refused write forgets it in its own file only", () => {
    const notes = new TrackWriteNotes()
    notes.note("ch1", ROW, null, { color: "teal" })
    notes.note("ch2", ROW, null, { color: "violet" })
    notes.forget("ch2", [ROW])
    expect(notes.read("ch2", ROW, null)).toBeNull()
    expect(notes.read("ch1", ROW, null)).toMatchObject({ color: "teal" })
  })
})
