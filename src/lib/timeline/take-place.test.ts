// AQU-2267 (Sam, Oct 29: "B makes the most sense"): a move moves a take by the
// same distance in both timings, each held by its own timing's limits.

import { describe, expect, it } from "vitest"
import { buildTimelineLayout, type TimelineLayout } from "./layout"
import { maxAudibleStartSec, minAudibleEndSec } from "./lane-timing"
import { clampMoveStart, movedStartSec, movedTakePlace, placeAfterMoveMs, type PlacedTake } from "./take-place"
import type { CellData } from "@/hooks/useCells"

const SOURCE_ID = "audio-f1-1690000000-shared.mp3"
const TRACK = "01a17e67-ef58-74f7-a093-be935876197b"

type Take = {
  durationMs?: number
  trimStartMs?: number
  trimEndMs?: number
  targetOffsetMs?: number
  recordingsOffsetMs?: number
}
const takeId = (id: string) => `audio-${id}-1700000000-take.wav`
const trackId = (id: string) => `audio-${id}-1700000500-track.wav`

function line(id: string, startTime: number, endTime: number, take?: Take, track?: Take): CellData {
  return {
    id, fileId: "f1", original: id, translated: "", medium: "media", startTime, endTime,
    ...(take ? { selectedAudioId: takeId(id) } : {}),
    ...(track ? { selectedBySlot: { [TRACK]: trackId(id) } } : {}),
    attachments: {
      ...(take ? { [takeId(id)]: { type: "audio", url: "frontier-audio://take", slot: "recording", ...take } } : {}),
      ...(track ? { [trackId(id)]: { type: "audio", url: "frontier-audio://track", slot: TRACK, ...track } } : {}),
      [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
    },
  } as unknown as CellData
}

function verse(id: string, take?: Take): CellData {
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
    ...(take ? { selectedAudioId: takeId(id) } : {}),
    attachments: take ? { [takeId(id)]: { type: "audio", url: "frontier-audio://take", slot: "recording", ...take } } : {},
  } as unknown as CellData
}

/** The LOTE sermon on the demo, "Session 4": five lines with a take each. Line
 *  2's take is given the 1.0 s lead Sam described, following the source. */
const sermon = (l2: Take = { durationMs: 4_600, targetOffsetMs: -1_000 }) => [
  line("l1", 0, 3.2, { durationMs: 2_600 }),
  line("l2", 3.4, 7, l2),
  line("l3", 7.3, 8.4, { durationMs: 1_700, targetOffsetMs: 203 }),
  line("l4", 9.6, 13.8, { durationMs: 5_000, targetOffsetMs: 800 }),
  line("l5", 14, 16.5, { durationMs: 2_900 }),
]

const layouts = (cells: CellData[], opts?: object) => ({
  source: buildTimelineLayout("dubbing", cells, cells, null, opts),
  recordings: buildTimelineLayout("audioFirst", cells, cells, null, { standInLenSec: () => 1, ...opts }),
})
const mainTrack = (cells: CellData[]): PlacedTake[] =>
  cells.filter((c) => c.selectedAudioId).map((cell) => ({ cell, audioId: takeId(cell.id) }))

/** A drag of `deltaSec` on the chip as `here` draws it, as the lane hands it
 *  over: from its drawn start to the dropped start, after `here`'s own clamp
 *  (the lane's move arm, which is `movedStartSec`'s arithmetic). */
function drag(here: TimelineLayout, other: TimelineLayout | null, track: PlacedTake[], take: PlacedTake, deltaSec: number) {
  const geom = here.targetGeom(take.cell, take.cell.attachments?.[take.audioId], take.audioId)!
  return movedTakePlace({ here, other, track, take, fromStartSec: geom.start, toStartSec: movedStartSec(here, track, take, deltaSec)! })
}

describe("a move, in both timings (AQU-2267)", () => {
  it("THE SERMON EXAMPLE: 0.2 s right following the recordings leaves it at −0.8 s following the source and +0.2 s following the recordings", () => {
    const cells = sermon()
    const { source, recordings } = layouts(cells)
    const take = { cell: cells[1], audioId: takeId("l2") }
    const moved = drag(recordings, source, mainTrack(cells), take, 0.2)!
    expect(moved.place).toEqual({ targetOffsetMs: -800, recordingsOffsetMs: 200 })
    // The anchor handed up is the timing's own: line start plus the new pause.
    expect(moved.anchorSec).toBeCloseTo(3.6, 5)
  })

  it("0.5 s left following the source: −1.5 s there, and following the recordings no further than its line's start", () => {
    const cells = sermon()
    const { source, recordings } = layouts(cells)
    const take = { cell: cells[1], audioId: takeId("l2") }
    expect(drag(source, recordings, mainTrack(cells), take, -0.5)!.place).toEqual({ targetOffsetMs: -1_500, recordingsOffsetMs: 0 })
    // With a pause of 0.3 s of its own there, it loses all of it and stops.
    const paused = sermon({ durationMs: 4_600, targetOffsetMs: -1_000, recordingsOffsetMs: 300 })
    const p = layouts(paused)
    expect(drag(p.source, p.recordings, mainTrack(paused), { cell: paused[1], audioId: takeId("l2") }, -0.5)!.place)
      .toEqual({ targetOffsetMs: -1_500, recordingsOffsetMs: 0 })
  })

  it("0.5 s right following the source moves the pause the same 0.5 s following the recordings", () => {
    const cells = sermon({ durationMs: 4_600, targetOffsetMs: -1_000, recordingsOffsetMs: 300 })
    const { source, recordings } = layouts(cells)
    expect(drag(source, recordings, mainTrack(cells), { cell: cells[1], audioId: takeId("l2") }, 0.5)!.place)
      .toEqual({ targetOffsetMs: -500, recordingsOffsetMs: 800 })
  })

  it("is held by the OTHER timing's own limits: following the source the take must keep touching its line", () => {
    const cells = sermon()
    const { source, recordings } = layouts(cells)
    const take = { cell: cells[1], audioId: takeId("l2") }
    // 5 s right following the recordings (a pause of 5 s: its line grows).
    const moved = drag(recordings, source, mainTrack(cells), take, 5)!
    expect(moved.place.recordingsOffsetMs).toBe(5_000)
    // Following the source it may start no later than just inside its line's
    // end (7.0 s less the 0.05 s grip): +3.55 s from the line's start.
    expect(moved.place.targetOffsetMs).toBe(Math.round((maxAudibleStartSec({ start: 3.4, end: 7 }) - 3.4) * 1000))
  })

  it("…and by its neighbour on the track following the source", () => {
    // Line 3's take sits at 7.3 + 0.203 = 7.503 s; line 2's, at −1.0 s, may
    // not pass it.
    const cells = sermon({ durationMs: 400, targetOffsetMs: -1_000 })
    const { source, recordings } = layouts(cells)
    const moved = drag(recordings, source, mainTrack(cells), { cell: cells[1], audioId: takeId("l2") }, 6)!
    expect(moved.place.recordingsOffsetMs).toBe(6_000)
    expect(moved.place.targetOffsetMs).toBe(Math.round((maxAudibleStartSec({ start: 3.4, end: 7 }) - 3.4) * 1000))
    const crowded = [line("l1", 0, 3, { durationMs: 1_000 }), line("l2", 3, 9, { durationMs: 400 }), line("l3", 4, 9, { durationMs: 1_000 })]
    const c = layouts(crowded)
    const m = drag(c.recordings, c.source, mainTrack(crowded), { cell: crowded[1], audioId: takeId("l2") }, 3)!
    // Line 3's take starts at 4 s: line 2's may start no later, +1 s.
    expect(m.place).toEqual({ targetOffsetMs: 1_000, recordingsOffsetMs: 3_000 })
  })

  it("a nudge under the pause threshold following the recordings stores nothing — it used to put the take on its line following the source", () => {
    const cells = sermon()
    const { source, recordings } = layouts(cells)
    expect(drag(recordings, source, mainTrack(cells), { cell: cells[1], audioId: takeId("l2") }, 0.03)).toBeNull()
  })

  it("a take with one place gets both on its first move; a take never placed reads its line's start", () => {
    const cells = sermon({ durationMs: 4_600 })
    const { source, recordings } = layouts(cells)
    expect(drag(recordings, source, mainTrack(cells), { cell: cells[1], audioId: takeId("l2") }, 0.4)!.place)
      .toEqual({ targetOffsetMs: 400, recordingsOffsetMs: 400 })
  })

  it("with no layout for the other timing, the other place moves the same distance with no limits of its own", () => {
    const cells = sermon()
    const { recordings } = layouts(cells)
    expect(drag(recordings, null, mainTrack(cells), { cell: cells[1], audioId: takeId("l2") }, 0.2)!.place)
      .toEqual({ targetOffsetMs: -800, recordingsOffsetMs: 200 })
  })

  it("a book's line has no place following the source, so that number moves the same distance, unheld", () => {
    const cells = [verse("v1", { durationMs: 2_000 }), verse("v2", { durationMs: 2_000, targetOffsetMs: 300 })]
    const { source, recordings } = layouts(cells)
    const moved = drag(recordings, source, mainTrack(cells), { cell: cells[1], audioId: takeId("v2") }, 0.5)!
    expect(moved.place).toEqual({ targetOffsetMs: 800, recordingsOffsetMs: 800 })
    // …and it reads back where it was dropped.
    const after = [cells[0], verse("v2", { durationMs: 2_000, ...moved.place })]
    expect(layouts(after).recordings.programme!.slots[1].targetLeadSec).toBeCloseTo(0.8, 5)
  })

  it("a piece of a split take moves in both timings, each piece where it was put", () => {
    const TAKE = takeId("a")
    const PIECE = "audio-a-1700000900-piece.wav"
    const cell = {
      ...line("a", 2, 6),
      selectedAudioId: TAKE,
      attachments: {
        [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000, trimEndMs: 1500 },
        [PIECE]: { type: "audio", url: "frontier-audio://take", slot: "recording", pieceOf: TAKE, durationMs: 4000, trimStartMs: 2500, trimEndMs: 3700 },
        [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
      },
    } as unknown as CellData
    const cells = [line("l0", 0, 2, { durationMs: 2_000 }), cell]
    const { source, recordings } = layouts(cells)
    const track = [{ cell: cells[0], audioId: takeId("l0") }, { cell, audioId: TAKE }, { cell, audioId: PIECE }]
    // Following the recordings the piece sits right after the first (1.5 s in);
    // dragged 0.4 s right, it leaves a 0.4 s silence before it. (A piece's
    // place there is where its clip starts, measured as following the source
    // — AQU-1758 — so 0.4 s along from where the take, played straight
    // through, puts it.)
    const moved = drag(recordings, source, track, { cell, audioId: PIECE }, 0.4)!
    expect(moved.place.recordingsOffsetMs).toBe(400)
    // Following the source its clip's start was on the line, so its sound at
    // 2 + 2.5 = 4.5 s; now 0.4 s later.
    expect(moved.place.targetOffsetMs).toBe(400)
  })

  it("…and the same on a voice track, moved following the source", () => {
    const TAKE = trackId("a")
    const PIECE = "audio-a-1700000900-piece.wav"
    const cell = {
      ...line("a", 2, 6, { durationMs: 1_000 }),
      selectedBySlot: { [TRACK]: TAKE },
      attachments: {
        [takeId("a")]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 1000 },
        [TAKE]: { type: "audio", url: "frontier-audio://track", slot: TRACK, durationMs: 4000, trimEndMs: 1500 },
        [PIECE]: { type: "audio", url: "frontier-audio://track", slot: TRACK, pieceOf: TAKE, durationMs: 4000, trimStartMs: 2500, trimEndMs: 3700 },
        [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
      },
    } as unknown as CellData
    const cells = [cell]
    const { source, recordings } = layouts(cells, { layerSlots: [TRACK] })
    const track = [{ cell, audioId: TAKE }, { cell, audioId: PIECE }]
    // 0.3 s right following the source; following the recordings it leaves
    // 0.3 s of silence after the first piece (1.5 s in): 1.8 s.
    const moved = drag(source, recordings, track, { cell, audioId: PIECE }, 0.3)!
    expect(moved.place).toEqual({ targetOffsetMs: 300, recordingsOffsetMs: 300 })
    const after = { ...cell, attachments: { ...cell.attachments, [PIECE]: { ...cell.attachments![PIECE], ...moved.place } } } as unknown as CellData
    const piece = layouts([after], { layerSlots: [TRACK] }).recordings.targetGeom(after, after.attachments![PIECE] as never, PIECE)!
    expect(piece.start).toBeCloseTo(1.8, 5)
  })
})

// AQU-2252's layer rules, following the recordings, for a move made following
// the source: its lead-in limit and the previous take on its track.
describe("a layer moved following the source (AQU-2267)", () => {
  const opts = { layerSlots: [TRACK], layerTrackSlots: [TRACK] }
  /** l1 0–3 and l2 3–6, each with a 2 s main take; Track 1 a layer. */
  const withLayers = (l1?: Take, l2?: Take) => [line("l1", 0, 3, { durationMs: 2_000 }, l1), line("l2", 3, 6, { durationMs: 2_000 }, l2)]
  const L2: Take = { durationMs: 3141, trimStartMs: 841, trimEndMs: 2896, targetOffsetMs: 1000 }
  const layerTrack = (cells: CellData[]) => cells.filter((c) => c.selectedBySlot).map((cell) => ({ cell, audioId: trackId(cell.id) }))

  it("following the recordings it may lead in before its line, but stops at the previous take on its track", () => {
    const cells = withLayers({ durationMs: 800, targetOffsetMs: 1200 }, L2)
    const { source, recordings } = layouts(cells, opts)
    const moved = drag(source, recordings, layerTrack(cells), { cell: cells[1], audioId: trackId("l2") }, -5)!
    // Following the source it stops at l1's layer take (1.2 s): its clip's
    // start a 0.841 s head trim before that, 2.641 s before its line.
    expect(moved.place.targetOffsetMs).toBe(-2_641)
    // Following the recordings l2 starts at 2 s and l1's layer take at 1.2 s:
    // it leads in 0.8 s and stops there.
    expect(moved.place.recordingsOffsetMs).toBe(-1_641)
  })

  it("following the recordings it never sounds before the start of the file", () => {
    const cells = withLayers(undefined, L2)
    const { source, recordings } = layouts(cells, opts)
    const moved = drag(source, recordings, layerTrack(cells), { cell: cells[1], audioId: trackId("l2") }, -5)!
    // Following the source its end must reach into its line: it sounds from 0.995 s.
    expect(moved.place.targetOffsetMs).toBe(Math.round((minAudibleEndSec({ start: 3, end: 6 }) - 2.055 - 0.841 - 3) * 1000))
    // Following the recordings its clip may start no earlier than the file:
    // l2 starts at 2 s there, so 2 s before its line.
    expect(moved.place.recordingsOffsetMs).toBe(-2_000)
  })
})

describe("clampMoveStart — the lane's move clamp (AQU-2267)", () => {
  const section = { start: 3, end: 6 }
  it("free (a voice take following the recordings): only its line's start", () => {
    expect(clampMoveStart(1, { free: true, lineStartSec: 2, section, lenSec: 1, prevChipStartSec: 2.5, nextChipStartSec: 2.6, trimStartSec: 0 })).toBe(2)
    expect(clampMoveStart(40, { free: true, lineStartSec: 2, section, lenSec: 1, prevChipStartSec: null, nextChipStartSec: 3, trimStartSec: 0 })).toBe(40)
  })
  it("not free: touching its line, between its neighbours' starts, never before the start of the file", () => {
    const c = { free: false, lineStartSec: null, section, lenSec: 1, prevChipStartSec: null, nextChipStartSec: null, trimStartSec: 0 }
    expect(clampMoveStart(9, c)).toBeCloseTo(maxAudibleStartSec(section), 5)
    expect(clampMoveStart(0, c)).toBeCloseTo(minAudibleEndSec(section) - 1, 5)
    expect(clampMoveStart(5, { ...c, nextChipStartSec: 4 })).toBe(4)
    expect(clampMoveStart(2.2, { ...c, prevChipStartSec: 2.5 })).toBe(2.5)
    expect(clampMoveStart(2.1, { ...c, lenSec: 3, trimStartSec: 2.3 })).toBe(2.3)
  })
})

describe("placeAfterMoveMs (AQU-2267)", () => {
  it("is null for a take the layout cannot move: following the recordings, one of unknown length", () => {
    const cells = [line("l1", 0, 3, {})]
    const { recordings } = layouts(cells)
    expect(placeAfterMoveMs(recordings, mainTrack(cells), { cell: cells[0], audioId: takeId("l1") }, 1)).toBeNull()
  })
})
