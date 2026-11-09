// AQU-2432 (Sam, Nov 9): dragging a take against a line NOBODY HAS RECORDED
// sets that line's ROOM. These pin the decision, rule by rule, in the layout
// every surface reads (the timeline, the transport, the exports):
//   1. the room belongs to the empty line; nothing is stored on the dragged take;
//   2. the room is at most the line's natural length; dragging later gives it
//      back first, and only past that is the take's own pause;
//   3. when the empty line gets a take, its take sets its length and the room
//      is ignored — so a room closed long ago can never turn into an overlap;
//   4. several empty lines close up one after another, and the drag stops at
//      the end of the nearest recorded line;
//   5. an old pull-back stored on a take whose line before is empty reads as none;
//   6. a room shorter than the line's original cuts the original there.

import { describe, expect, it } from "vitest"
import {
  buildProgramme,
  isUnrecordedSlot,
  layOutProgramme,
  playedProgramme,
  roomFloorSec,
  roomsForMove,
  slotHasNothingToPlay,
  type BuildProgrammeOptions,
} from "./programme"
import { buildTimelineLayout } from "./layout"
import { movedStartSec, movedTakePlace } from "./take-place"
import { lineRoomKey, lineRoomMsFromMetadata, type LineRoomChange } from "./line-room"
import type { CellData } from "@/hooks/useCells"

const VOICE = "01a17e67-ef58-74f7-a093-be935876197b"
const MUSIC = "0b9b2d44-1f5e-7f11-9d0e-3c6a2b8d4e10"
const SOURCE_ID = "audio-f1-1690000000-shared.mp3"

type Take = { durationMs?: number; trimStartMs?: number; trimEndMs?: number; targetOffsetMs?: number; recordingsOffsetMs?: number; pieceOf?: string }

const takeId = (id: string) => `audio-${id}-1700000000-take.wav`
const trackTakeId = (id: string, slot: string) => `audio-${id}-1700000500-${slot.slice(0, 4)}.wav`

/** A book's line (no times). `take` is its take on the main track; `others`
 *  its takes on added tracks; `roomMs` the room stored on it. */
function bookLine(
  id: string,
  opts: { take?: Take; others?: Record<string, Take>; roomMs?: number; words?: string } = {},
): CellData {
  const { take, others = {}, roomMs } = opts
  return {
    id, fileId: "f1", original: opts.words ?? `${id} words`, translated: "", medium: "text",
    ...(take ? { selectedAudioId: takeId(id) } : {}),
    ...(Object.keys(others).length > 0 ? { selectedBySlot: Object.fromEntries(Object.keys(others).map((s) => [s, trackTakeId(id, s)])) } : {}),
    ...(roomMs != null ? { recordingsRoomMs: roomMs } : {}),
    attachments: {
      ...(take ? { [takeId(id)]: { type: "audio", url: "frontier-audio://take", slot: "recording", ...take } } : {}),
      ...Object.fromEntries(Object.entries(others).map(([s, t]) => [trackTakeId(id, s), { type: "audio", url: `frontier-audio://${s}`, slot: s, ...t }])),
    },
  } as unknown as CellData
}

/** Every unrecorded line of these books stands in at 4 s. */
const BOOK: BuildProgrammeOptions = { standInLenSec: () => 4 }
const layoutOf = (cells: CellData[], opts: BuildProgrammeOptions = BOOK) => buildTimelineLayout("audioFirst", cells, cells, null, opts)
const spans = (cells: CellData[], opts: BuildProgrammeOptions = BOOK) =>
  buildProgramme(cells, opts).slots.map((s) => [s.startSec, s.startSec + s.slotLenSec])

/** The cells with a move's rooms stored on their lines (null: back to natural). */
function withRooms(cells: CellData[], rooms: readonly LineRoomChange[]): CellData[] {
  return cells.map((c) => {
    const change = rooms.find((r) => r.cellId === c.id)
    if (!change) return c
    const { recordingsRoomMs: _old, ...rest } = c
    return (change.roomMs == null ? rest : { ...rest, recordingsRoomMs: change.roomMs }) as CellData
  })
}

/** Drag `cell`'s take (on the main track unless `audioId`) to `toSec`, the way
 *  the lane does: clamp to the bounds, let the rooms take their share, and
 *  read the take's own place from what is left. */
function drag(cells: CellData[], id: string, toSec: number, opts: BuildProgrammeOptions = BOOK, audioId = takeId(id)) {
  const layout = layoutOf(cells, opts)
  const cell = cells.find((c) => c.id === id)!
  const att = cell.attachments?.[audioId]
  const from = layout.targetGeom(cell, att, audioId)!.start
  const bounds = layout.moveBounds(cell, att, audioId)!
  const to = Math.max(toSec, bounds.roomFloorSec ?? bounds.floorSec)
  const rooms = layout.roomsForMove(cell, att, audioId, from, to)
  const moved = movedTakePlace({
    here: layout, other: null, track: [{ cell, audioId }], take: { cell, audioId },
    fromStartSec: from, toStartSec: rooms ? rooms.takeStartSec : to,
  })
  return { rooms: rooms?.rooms ?? null, place: moved?.place ?? null, from, to }
}

describe("the room is stored per language, beside the line's other timeline state", () => {
  it("the default language's key is plain; another language's carries its tag", () => {
    expect(lineRoomKey("")).toBe("recordings_room_ms")
    expect(lineRoomKey("fr")).toBe("recordings_room_ms:fr")
    const meta = { recordings_room_ms: 1500, "recordings_room_ms:fr": 0 }
    expect(lineRoomMsFromMetadata(meta, "")).toBe(1500)
    expect(lineRoomMsFromMetadata(meta, "fr")).toBe(0)
    expect(lineRoomMsFromMetadata(meta, "ar")).toBeUndefined()
    expect(lineRoomMsFromMetadata({ recordings_room_ms: "soon" }, "")).toBeUndefined()
    expect(lineRoomMsFromMetadata(null, "")).toBeUndefined()
  })
})

describe("1. the room belongs to the empty line (AQU-2432, Nov 9)", () => {
  const book = () => [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b"), bookLine("c", { take: { durationMs: 6_000 } })]

  it("dragging the next take earlier makes the empty line's room smaller, and stores nothing on the take", () => {
    expect(spans(book())).toEqual([[0, 5], [5, 9], [9, 15]])
    const { rooms, place } = drag(book(), "c", 7.5)
    expect(rooms).toEqual([{ cellId: "b", roomMs: 2_500 }])
    expect(place).toBeNull()
    const after = withRooms(book(), rooms!)
    expect(spans(after)).toEqual([[0, 5], [5, 7.5], [7.5, 13.5]])
    const [a, b, c] = buildProgramme(after, BOOK).slots
    expect(a.slotLenSec).toBe(5) // the recorded line before is untouched
    expect(b.naturalLenSec).toBe(4)
    expect(c.pulledBackSec).toBeUndefined()
    expect(c.targetLeadSec).toBeUndefined()
  })

  it("down to nothing: the take then sits right at the end of the recorded line before", () => {
    const { rooms, place, to } = drag(book(), "c", 1)
    expect(to).toBe(5) // the drag stops there
    expect(rooms).toEqual([{ cellId: "b", roomMs: 0 }])
    expect(place).toBeNull()
    const [a, b, c] = buildProgramme(withRooms(book(), rooms!), BOOK).slots
    expect([b.startSec, b.slotLenSec]).toEqual([5, 0])
    expect(c.startSec).toBe(5)
    expect(a.slotLenSec).toBe(5)
    expect(c.pulledBackSec).toBeUndefined()
  })

  it("the take's own pause closes first; only past its line's start does the room close", () => {
    const paused = [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b"), bookLine("c", { take: { durationMs: 6_000, recordingsOffsetMs: 1_000 } })]
    // c's line starts at 9 and its take 1 s in, at 10. Dragged to 8: 1 s of pause, 1 s of room.
    const { rooms, place } = drag(paused, "c", 8)
    expect(rooms).toEqual([{ cellId: "b", roomMs: 3_000 }])
    expect(place?.recordingsOffsetMs).toBe(0)
  })

  it("a nudge under the wobble changes no room", () => {
    expect(drag(book(), "c", 8.97).rooms).toBeNull()
  })

  it("a stored room means nothing to a line that is not laid out from it: it is never more than natural, never below zero", () => {
    const wide = [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b", { roomMs: 60_000 }), bookLine("c", { take: { durationMs: 6_000 } })]
    expect(spans(wide)).toEqual([[0, 5], [5, 9], [9, 15]])
    expect(buildProgramme(wide, BOOK).slots[1].naturalLenSec).toBeUndefined()
    const bad = [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b", { roomMs: -200 }), bookLine("c", { take: { durationMs: 6_000 } })]
    expect(spans(bad)).toEqual([[0, 5], [5, 9], [9, 15]])
  })
})

describe("2. dragging later gives the room back first, then is the take's own pause", () => {
  const closed = () => [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b", { roomMs: 1_000 }), bookLine("c", { take: { durationMs: 6_000 } })]

  it("later, inside the missing room: the room grows and the take keeps no pause", () => {
    // b has 1 s of its 4; c's take is at 6. Dragged to 8: b gets 2 s back.
    const { rooms, place } = drag(closed(), "c", 8)
    expect(rooms).toEqual([{ cellId: "b", roomMs: 3_000 }])
    expect(place).toBeNull()
  })

  it("later, past the natural length: the room is whole again (nothing stored) and the rest is the take's pause", () => {
    // 3 s missing; dragged 5 s later (6 → 11): 3 s of room, 2 s of pause.
    const { rooms, place } = drag(closed(), "c", 11)
    expect(rooms).toEqual([{ cellId: "b", roomMs: null }])
    expect(place?.recordingsOffsetMs).toBe(2_000)
    const cells = withRooms(closed(), rooms!).map((c) =>
      c.id === "c" ? bookLine("c", { take: { durationMs: 6_000, recordingsOffsetMs: 2_000 } }) : c)
    const [, b, c] = buildProgramme(cells, BOOK).slots
    expect(b.slotLenSec).toBe(4)
    expect(b.naturalLenSec).toBeUndefined()
    expect(c.startSec + (c.targetLeadSec ?? 0)).toBe(11) // where it was dropped
  })

  it("with the room whole, a drag later is the take's pause alone, as before", () => {
    const whole = [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b"), bookLine("c", { take: { durationMs: 6_000 } })]
    const { rooms, place } = drag(whole, "c", 10.5)
    expect(rooms).toBeNull()
    expect(place?.recordingsOffsetMs).toBe(1_500)
  })
})

describe("3. when the empty line gets a take, its take sets its length", () => {
  it("Sam's scenario: 5 s take / 4 s empty / 6 s take, the third dragged 4 s back, then line 2 recorded at 3 s — no overlap, ever", () => {
    const before = [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b"), bookLine("c", { take: { durationMs: 6_000 } })]
    const { rooms, place } = drag(before, "c", 5)
    expect(place).toBeNull() // nothing on the dragged take to bite later
    const closed = withRooms(before, rooms!)
    expect(spans(closed)).toEqual([[0, 5], [5, 5], [5, 11]])

    // Someone records line 2: a 3 s take. Its stored room (0) is ignored.
    const recorded = closed.map((c) => (c.id === "b" ? bookLine("b", { take: { durationMs: 3_000 }, roomMs: 0 }) : c))
    const [a, b, c] = buildProgramme(recorded, BOOK).slots
    expect([a.startSec, a.slotLenSec]).toEqual([0, 5])
    expect([b.startSec, b.slotLenSec]).toEqual([5, 3]) // its take sets its length
    expect(b.naturalLenSec).toBeUndefined()
    expect(c.startSec).toBe(8) // the line after follows it
    expect(c.pulledBackSec).toBeUndefined()
    // Each take starts where the one before it ends.
    expect(b.startSec + (b.targetLeadSec ?? 0)).toBe(a.startSec + a.targetLenSec)
    expect(c.startSec + (c.targetLeadSec ?? 0)).toBe(b.startSec + b.targetLenSec)
  })

  it("the room applies again only if the line becomes empty again", () => {
    const emptied = [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b", { roomMs: 0 }), bookLine("c", { take: { durationMs: 6_000 } })]
    expect(spans(emptied)).toEqual([[0, 5], [5, 5], [5, 11]])
  })

  it("a take on a voice track is a take: the line is recorded, and its room is ignored", () => {
    const voiced = [
      bookLine("a", { take: { durationMs: 5_000 } }),
      bookLine("b", { others: { [VOICE]: { durationMs: 2_000 } }, roomMs: 0 }),
      bookLine("c", { take: { durationMs: 6_000 } }),
    ]
    const opts = { ...BOOK, layerSlots: [VOICE] }
    const prog = buildProgramme(voiced, opts)
    expect(isUnrecordedSlot(prog.slots[1])).toBe(false)
    expect(spans(voiced, opts)).toEqual([[0, 5], [5, 7], [7, 13]])
    expect(roomFloorSec(prog, prog.slots[2])).toBeNull()
  })

  it("a take on a track made a layer sets no length: the line is still unrecorded, and keeps its room", () => {
    const scored = [
      bookLine("a", { take: { durationMs: 5_000 } }),
      bookLine("b", { others: { [MUSIC]: { durationMs: 9_000 } }, roomMs: 1_000 }),
      bookLine("c", { take: { durationMs: 6_000 } }),
    ]
    const opts = { ...BOOK, layerSlots: [MUSIC], layerTrackSlots: [MUSIC] }
    expect(isUnrecordedSlot(buildProgramme(scored, opts).slots[1])).toBe(true)
    expect(spans(scored, opts)).toEqual([[0, 5], [5, 6], [6, 12]])
  })
})

describe("4. several empty lines in a row close up one after another", () => {
  const book = () => [
    bookLine("a", { take: { durationMs: 5_000 } }),
    bookLine("b"),
    bookLine("c"),
    bookLine("d", { take: { durationMs: 6_000 } }),
  ]

  it("the line directly before the take closes first, then the one before it — each its own room", () => {
    expect(spans(book())).toEqual([[0, 5], [5, 9], [9, 13], [13, 19]])
    const { rooms, place } = drag(book(), "d", 7)
    expect(rooms).toEqual([{ cellId: "c", roomMs: 0 }, { cellId: "b", roomMs: 2_000 }])
    expect(place).toBeNull()
    expect(spans(withRooms(book(), rooms!))).toEqual([[0, 5], [5, 7], [7, 7], [7, 13]])
  })

  it("with every empty line at zero the drag STOPS at the end of the nearest recorded line; it never overlaps that take", () => {
    const layout = layoutOf(book())
    const d = book()[3]
    const bounds = layout.moveBounds(d, d.attachments?.[takeId("d")], takeId("d"))!
    expect(bounds.roomFloorSec).toBe(5)
    expect(bounds.floorSec).toBe(13) // the take's own place never goes before its line
    const { rooms, to, place } = drag(book(), "d", 0)
    expect(to).toBe(5)
    expect(rooms).toEqual([{ cellId: "c", roomMs: 0 }, { cellId: "b", roomMs: 0 }])
    expect(place).toBeNull()
    const closed = withRooms(book(), rooms!)
    const [a, , , dSlot] = buildProgramme(closed, BOOK).slots
    expect(dSlot.startSec).toBe(5)
    expect(a.slotLenSec).toBe(5)
    expect(dSlot.pulledBackSec).toBeUndefined()
    // …and from there it cannot be dragged earlier at all.
    const again = layoutOf(closed).moveBounds(closed[3], closed[3].attachments?.[takeId("d")], takeId("d"))!
    expect(again.roomFloorSec).toBe(5)
    expect(drag(closed, "d", 2).rooms).toBeNull()
  })

  it("giving room back: the line directly before the take first, then the one before it, then the pause", () => {
    const closed = withRooms(book(), [{ cellId: "c", roomMs: 0 }, { cellId: "b", roomMs: 2_000 }])
    // d's take is at 7. Dragged to 9: c gets 2 s.
    expect(drag(closed, "d", 9).rooms).toEqual([{ cellId: "c", roomMs: 2_000 }])
    // Dragged to 14.5: c gets its 4 s, b its missing 2 s, and 1.5 s is the pause.
    const far = drag(closed, "d", 14.5)
    expect(far.rooms).toEqual([{ cellId: "c", roomMs: null }, { cellId: "b", roomMs: null }])
    expect(far.place?.recordingsOffsetMs).toBe(1_500)
  })

  it("empty lines at the START of the file close up to the file's start", () => {
    const opening = [bookLine("a"), bookLine("b"), bookLine("c", { take: { durationMs: 6_000 } })]
    const { rooms, to } = drag(opening, "c", -3)
    expect(to).toBe(0)
    expect(rooms).toEqual([{ cellId: "b", roomMs: 0 }, { cellId: "a", roomMs: 0 }])
    expect(spans(withRooms(opening, rooms!))).toEqual([[0, 0], [0, 0], [0, 6]])
  })

  it("the first line of a file has no line before it: nothing to close", () => {
    const first = [bookLine("a", { take: { durationMs: 5_000, recordingsOffsetMs: 1_000 } }), bookLine("b")]
    const { rooms, place, to } = drag(first, "a", -2)
    expect(to).toBe(0)
    expect(rooms).toBeNull()
    expect(place?.recordingsOffsetMs).toBe(0)
  })
})

describe("5. an old pull-back on a take whose line before is empty reads as none", () => {
  it("the take starts on its line; the empty line keeps its room; the line before it is whole", () => {
    const old = [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b"), bookLine("c", { take: { durationMs: 6_000, recordingsOffsetMs: -4_000 } })]
    expect(spans(old)).toEqual([[0, 5], [5, 9], [9, 15]])
    const [, , c] = buildProgramme(old, BOOK).slots
    expect(c.pulledBackSec).toBeUndefined()
    expect(c.targetLeadSec).toBeUndefined()
  })

  it("…with the empty line's room closed as well", () => {
    const old = [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b", { roomMs: 0 }), bookLine("c", { take: { durationMs: 6_000, recordingsOffsetMs: -4_000 } })]
    const [a, , c] = buildProgramme(old, BOOK).slots
    expect(c.startSec).toBe(5)
    expect(a.slotLenSec).toBe(5)
    expect(c.pulledBackSec).toBeUndefined()
  })

  it("a pull-back over a RECORDED line is what it was: an overlap", () => {
    const over = [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b", { take: { durationMs: 6_000, recordingsOffsetMs: -1_000 } })]
    const [a, b] = buildProgramme(over, BOOK).slots
    expect(b.pulledBackSec).toBe(1)
    expect(a.slotLenSec).toBe(4)
  })
})

describe("6. a line with an original to hear: a room shorter than the original cuts it there", () => {
  /** A timed line of an imported recording. */
  function heard(id: string, startTime: number, endTime: number, opts: { take?: Take; roomMs?: number } = {}): CellData {
    return {
      id, fileId: "f1", original: id, translated: "", medium: "media", startTime, endTime,
      ...(opts.take ? { selectedAudioId: takeId(id) } : {}),
      ...(opts.roomMs != null ? { recordingsRoomMs: opts.roomMs } : {}),
      attachments: {
        ...(opts.take ? { [takeId(id)]: { type: "audio", url: "frontier-audio://take", slot: "recording", ...opts.take } } : {}),
        [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
      },
    } as unknown as CellData
  }

  it("the original sounds only as long as the room; what is cut is the natural length less the room", () => {
    const cells = [heard("l1", 0, 3, { take: { durationMs: 2_000 } }), heard("l2", 3, 7, { roomMs: 1_500 }), heard("l3", 7, 9, { take: { durationMs: 2_000 } })]
    const [, l2, l3] = buildProgramme(cells).slots
    expect(l2.slotLenSec).toBe(1.5)
    expect(l2.naturalLenSec).toBe(4)
    expect(l2.sourceLenSec).toBe(1.5)
    expect(l2.sourceWindow).toEqual({ start: 3, end: 4.5 })
    // What the "cut" mark reads: the original's own length less what sounds.
    expect(l2.nominalLenSec - l2.sourceLenSec).toBe(2.5)
    expect(l2.cardLenSec).toBe(1.5)
    expect(l2.clock).toBe("source")
    expect(l3.startSec).toBe(3.5)
  })

  it("with no room at all there is none of the original left to hear", () => {
    const cells = [heard("l1", 0, 3, { take: { durationMs: 2_000 } }), heard("l2", 3, 7, { roomMs: 0 }), heard("l3", 7, 9, { take: { durationMs: 2_000 } })]
    const [, l2] = buildProgramme(cells).slots
    expect(l2.slotLenSec).toBe(0)
    expect(l2.sourceWindow).toBeNull()
    expect(l2.clock).toBeNull()
  })

  it("the drag against it gives back up to the original's length", () => {
    const cells = [heard("l1", 0, 3, { take: { durationMs: 2_000 } }), heard("l2", 3, 7, { roomMs: 1_500 }), heard("l3", 7, 9, { take: { durationMs: 2_000 } })]
    const prog = buildProgramme(cells)
    // l3's take is at 3.5; dragged 4 s later: 2.5 s of room, 1.5 s of pause.
    const move = roomsForMove(prog, prog.slots[2], 3.5, 7.5)
    expect(move).toEqual({ rooms: [{ cellId: "l2", roomMs: null }], takeStartSec: 5 })
  })
})

describe("the same rule everywhere (siblings)", () => {
  it("an added voice track's take closes the room exactly as the main track's does: the room is the LINE's, one for every track", () => {
    const opts = { ...BOOK, layerSlots: [VOICE] }
    const cells = [
      bookLine("a", { take: { durationMs: 5_000 } }),
      bookLine("b"),
      bookLine("c", { others: { [VOICE]: { durationMs: 6_000 } } }),
    ]
    const { rooms, place } = drag(cells, "c", 6, opts, trackTakeId("c", VOICE))
    expect(rooms).toEqual([{ cellId: "b", roomMs: 1_000 }])
    expect(place).toBeNull()
    expect(spans(withRooms(cells, rooms!), opts)).toEqual([[0, 5], [5, 6], [6, 12]])
  })

  it("a line with takes on two tracks moves as one: the other track's take keeps its pause into the line", () => {
    const opts = { ...BOOK, layerSlots: [VOICE] }
    const cells = [
      bookLine("a", { take: { durationMs: 5_000 } }),
      bookLine("b"),
      bookLine("c", { take: { durationMs: 6_000 }, others: { [VOICE]: { durationMs: 2_000, recordingsOffsetMs: 500 } } }),
    ]
    const { rooms } = drag(cells, "c", 7, opts)
    const c = buildProgramme(withRooms(cells, rooms!), opts).slots[2]
    expect(c.startSec).toBe(7)
    expect(c.layers?.[0].atSec).toBe(0.5)
  })

  it("a take on a track made a layer never changes a room", () => {
    const opts = { ...BOOK, layerSlots: [MUSIC], layerTrackSlots: [MUSIC] }
    const cells = [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b"), bookLine("c", { take: { durationMs: 6_000 }, others: { [MUSIC]: { durationMs: 3_000 } } })]
    const layout = layoutOf(cells, opts)
    const id = trackTakeId("c", MUSIC)
    expect(layout.roomsForMove(cells[2], cells[2].attachments?.[id], id, 9, 6)).toBeNull()
  })

  it("pieces of a cut take: the first piece closes the room as a take does; a later piece moves inside its own line only", () => {
    const first = takeId("c")
    const second = "audio-c-1700000900-piece.wav"
    const cut = {
      ...bookLine("c"),
      selectedAudioId: first,
      attachments: {
        [first]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 6_000, trimEndMs: 2_000 },
        [second]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 6_000, trimStartMs: 2_000, pieceOf: first },
      },
    } as unknown as CellData
    const cells = [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b"), cut]
    const layout = layoutOf(cells)
    expect(layout.roomsForMove(cut, cut.attachments?.[first], first, 9, 6)).toEqual({ rooms: [{ cellId: "b", roomMs: 1_000 }], takeStartSec: 9 })
    expect(layout.roomsForMove(cut, cut.attachments?.[second], second, 11, 10)).toBeNull()
    expect(layout.moveBounds(cut, cut.attachments?.[second], second)?.roomFloorSec).toBeUndefined()
    // Both pieces move up with their line.
    const moved = buildProgramme(withRooms(cells, [{ cellId: "b", roomMs: 1_000 }]), BOOK).slots[2]
    expect(moved.startSec).toBe(6)
    expect(moved.targetPieces?.map((p) => p.atSec)).toEqual([0, 2])
  })

  it("a line with nothing at all (no words, no original) has a room like any other", () => {
    const cells = [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b", { words: "" }), bookLine("c", { take: { durationMs: 6_000 } })]
    const natural = layOutProgramme(cells).programme.slots[1].slotLenSec
    expect(natural).toBeGreaterThan(0)
    const closed = withRooms(cells, [{ cellId: "b", roomMs: 0 }])
    const [, b, c] = layOutProgramme(closed).programme.slots
    expect(b.slotLenSec).toBe(0)
    expect(b.naturalLenSec).toBe(natural)
    expect(c.startSec).toBe(5)
  })

  it("following the source nothing changes: no room is read, no drag changes one", () => {
    const cells = [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b", { roomMs: 0 }), bookLine("c", { take: { durationMs: 6_000 } })]
    const source = buildTimelineLayout("dubbing", cells, cells)
    expect(source.roomsForMove(cells[2], cells[2].attachments?.[takeId("c")], takeId("c"), 9, 5)).toBeNull()
    expect(source.moveBounds(cells[2], cells[2].attachments?.[takeId("c")], takeId("c"))).toBeNull()
  })

  it("a move made following the source never reaches into a room: carried here, the take stops at its line's start", () => {
    const cells = [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b"), bookLine("c", { take: { durationMs: 6_000, recordingsOffsetMs: 500 } })]
    const take = { cell: cells[2], audioId: takeId("c") }
    // The other timing carries a 3 s move earlier into this one: c's take is
    // at 9.5, and its line starts at 9.
    expect(movedStartSec(layoutOf(cells), [take], take, -3)).toBe(9)
  })

  it("playback: a line with no room has nothing to play, so the transport steps over it either way", () => {
    const cells = [bookLine("a", { take: { durationMs: 5_000 } }), bookLine("b", { roomMs: 0 }), bookLine("c", { take: { durationMs: 6_000 } })]
    const played = playedProgramme(cells)!
    const b = played.programme.slots[1]
    expect(b.slotLenSec).toBe(0)
    expect(slotHasNothingToPlay(b, played.hiddenCellIds, played.underLayers)).toBe(true)
    expect(played.programme.totalSec).toBe(11)
  })
})
