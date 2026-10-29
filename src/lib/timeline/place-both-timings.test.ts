// AQU-2267 (Sam, Oct 29: "B makes the most sense"): a take's place carries
// across both timings. A take keeps a place in each — `targetOffsetMs`
// following the source, `recordingsOffsetMs` following the recordings — and
// each timing reads its own. These pin the READING: where each timing draws
// and plays a take, and that a take with only the one place (every take before
// AQU-2267) reads exactly as it always has.

import { describe, expect, it } from "vitest"
import { buildProgramme } from "./programme"
import { buildTimelineLayout } from "./layout"
import { targetChipGeom } from "./lane-timing"
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

/** A timed line of the sermon: its source clip, a take, and optionally a take
 *  on an added track. */
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

/** A line of a book with no times (Ruth). */
function verse(id: string, take?: Take): CellData {
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
    ...(take ? { selectedAudioId: takeId(id) } : {}),
    attachments: take ? { [takeId(id)]: { type: "audio", url: "frontier-audio://take", slot: "recording", ...take } } : {},
  } as unknown as CellData
}

const att = (cell: CellData, id: string) => cell.attachments?.[id] as never

describe("each timing reads its own place (AQU-2267)", () => {
  // The sermon example after the move: 0.8 s before its line following the
  // source, 0.2 s into it following the recordings.
  const moved: Take = { durationMs: 4_600, targetOffsetMs: -800, recordingsOffsetMs: 200 }

  it("following the recordings, the pause before a take is its place there", () => {
    const [s1, s2] = buildProgramme([line("l1", 0, 3.2, { durationMs: 2_600 }), line("l2", 3.4, 7, moved)]).slots
    expect(s2.startSec).toBeCloseTo(2.6, 5)
    expect(s2.targetLeadSec).toBeCloseTo(0.2, 5)
    expect(s2.slotLenSec).toBeCloseTo(4.8, 5)
    expect(s1.targetLeadSec).toBeUndefined()
  })

  it("following the source, the take sits at its place there, whatever its place following the recordings", () => {
    const l2 = line("l2", 3.4, 7, moved)
    const geom = targetChipGeom(l2, att(l2, takeId("l2")))!
    expect(geom.anchor).toBeCloseTo(2.6, 5)
    expect(geom.start).toBeCloseTo(2.6, 5)
  })

  it("the timeline draws each timing at its own place", () => {
    const cells = [line("l1", 0, 3.2, { durationMs: 2_600 }), line("l2", 3.4, 7, moved)]
    const source = buildTimelineLayout("dubbing", cells, cells)
    const recordings = buildTimelineLayout("audioFirst", cells, cells)
    expect(source.targetGeom(cells[1], att(cells[1], takeId("l2")))!.start).toBeCloseTo(2.6, 5)
    // Line 2 starts at 2.6 s on the programme clock; the take 0.2 s into it.
    expect(recordings.targetGeom(cells[1], att(cells[1], takeId("l2")))!.start).toBeCloseTo(2.8, 5)
  })

  it("a place of exactly 0 following the recordings is a real place, not 'none'", () => {
    const [, s2] = buildProgramme([
      line("l1", 0, 3.2, { durationMs: 2_600 }),
      line("l2", 3.4, 7, { durationMs: 4_600, targetOffsetMs: 900, recordingsOffsetMs: 0 }),
    ]).slots
    expect(s2.targetLeadSec).toBeUndefined()
    expect(s2.slotLenSec).toBeCloseTo(4.6, 5)
  })

  it("each piece of a split take reads its own place following the recordings", () => {
    const TAKE = takeId("a")
    const PIECE = "audio-a-1700000900-piece.wav"
    const cell = {
      ...line("a", 0, 2),
      selectedAudioId: TAKE,
      attachments: {
        [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000, trimStartMs: 200, trimEndMs: 1500, targetOffsetMs: 0, recordingsOffsetMs: 0 },
        [PIECE]: {
          type: "audio", url: "frontier-audio://take", slot: "recording", pieceOf: TAKE, durationMs: 4000, trimStartMs: 2500, trimEndMs: 3700,
          // Dragged 2 s into the line following the recordings, 0.7 s after the
          // first piece ends (AQU-1758: a piece's place is where its clip
          // starts, so 0.7 s along); never moved following the source.
          targetOffsetMs: 0, recordingsOffsetMs: 700,
        },
        [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
      },
    } as unknown as CellData
    const [slot] = buildProgramme([cell]).slots
    expect(slot.targetPieces!.map((p) => p.atSec)).toEqual([0, 2])
  })

  it("a take on an added track that sets line lengths reads its place following the recordings", () => {
    const cells = [line("l1", 0, 3, { durationMs: 2_000 }, { durationMs: 1_000, targetOffsetMs: -500, recordingsOffsetMs: 700 })]
    const [slot] = buildProgramme(cells, { layerSlots: [TRACK] }).slots
    expect(slot.layers![0].atSec).toBeCloseTo(0.7, 5)
    expect(slot.slotLenSec).toBeCloseTo(2, 5) // 0.7 + 1.0 < the main take's 2 s
  })

  it("a take on a track made a layer reads its place following the recordings", () => {
    const cells = [
      line("l1", 0, 3, { durationMs: 2_000 }),
      line("l2", 3, 6, { durationMs: 2_000 }, { durationMs: 2_000, trimStartMs: 300, targetOffsetMs: 500, recordingsOffsetMs: -1_000 }),
    ]
    const [, s2] = buildProgramme(cells, { layerSlots: [TRACK], layerTrackSlots: [TRACK] }).slots
    // Its clip's start 1 s before its line, its sound a 0.3 s head trim later.
    expect(s2.layers![0].anchorSec).toBeCloseTo(-1, 5)
    expect(s2.layers![0].atSec).toBeCloseTo(-0.7, 5)
    // Following the source it is where its place there says.
    expect(targetChipGeom(cells[1], att(cells[1], trackId("l2")))!.anchor).toBeCloseTo(3.5, 5)
  })

  it("a book's line reads its place following the recordings, from the start of its slot", () => {
    const [, s2] = buildProgramme([verse("v1", { durationMs: 2_000 }), verse("v2", { durationMs: 2_000, targetOffsetMs: 0, recordingsOffsetMs: 600 })], {
      standInLenSec: () => 1,
    }).slots
    expect(s2.targetLeadSec).toBeCloseTo(0.6, 5)
  })
})

// OLD DATA READS EXACTLY AS IT DOES TODAY: a take with only one place — every
// take placed before AQU-2267, and every take nobody has moved — is read by
// both timings from that one place, as before.
describe("a take with one place reads as it always has (AQU-2267)", () => {
  it("following the recordings, a place before the line is no pause, and a place after it is the pause", () => {
    const [, s2, s3] = buildProgramme([
      line("l1", 0, 3.2, { durationMs: 2_600 }),
      line("l2", 3.4, 7, { durationMs: 4_600, targetOffsetMs: -1_000 }),
      line("l3", 7.3, 8.4, { durationMs: 1_700, targetOffsetMs: 203 }),
    ]).slots
    expect(s2.targetLeadSec).toBeUndefined()
    expect(s3.targetLeadSec).toBeCloseTo(0.203, 5)
  })

  it("a take placed on its LINE (before takes had places of their own) is read from the line in both timings", () => {
    const cell = { ...line("l1", 2, 5, { durationMs: 2_000 }), metadata: { target_offset_ms: 400 } } as CellData
    const [slot] = buildProgramme([cell]).slots
    expect(slot.targetLeadSec).toBeCloseTo(0.4, 5)
    expect(targetChipGeom(cell, att(cell, takeId("l1")))!.anchor).toBeCloseTo(2.4, 5)
  })

  it("a piece of a split take with one place sits that far along in both timings", () => {
    // AQU-1758: a piece's one place is where its clip starts, which is what
    // following the source reads, so reading it following the recordings too
    // is right for pieces: a piece moved 0.7 s along following the source
    // before AQU-2267 is 0.7 s along following the recordings.
    const TAKE = takeId("a")
    const PIECE = "audio-a-1700000900-piece.wav"
    const cut = (pieceOffsetMs?: number) =>
      ({
        ...line("a", 2, 6),
        selectedAudioId: TAKE,
        attachments: {
          [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000, trimStartMs: 200, trimEndMs: 1500 },
          [PIECE]: {
            type: "audio", url: "frontier-audio://take", slot: "recording", pieceOf: TAKE, durationMs: 4000, trimStartMs: 2500, trimEndMs: 3700,
            ...(pieceOffsetMs != null ? { targetOffsetMs: pieceOffsetMs } : {}),
          },
          [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
        },
      }) as unknown as CellData
    const piece = (cell: CellData) => att(cell, PIECE)
    // Never moved: end to end following the recordings (1.3 s in), where the
    // recording has it following the source (2.5 s in).
    const [still] = buildProgramme([cut()]).slots
    expect(still.targetPieces!.map((p) => [p.atSec, p.gapBeforeSec])).toEqual([[0, undefined], [expect.closeTo(1.3, 5), undefined]])
    expect(targetChipGeom(cut(), piece(cut()))!.start - 2).toBeCloseTo(2.5, 5)
    // Moved 0.7 s along: 0.7 s later in both.
    const moved = cut(700)
    const [slot] = buildProgramme([moved]).slots
    expect(slot.targetPieces!.map((p) => [p.atSec, p.gapBeforeSec])).toEqual([[0, undefined], [expect.closeTo(2, 5), expect.closeTo(0.7, 5)]])
    expect(targetChipGeom(moved, piece(moved))!.start - 2).toBeCloseTo(3.2, 5)
  })

  it("a layer with one place sits there in both timings", () => {
    const cells = [line("l1", 0, 3, { durationMs: 2_000 }, { durationMs: 1_000, targetOffsetMs: -400 })]
    const [slot] = buildProgramme(cells, { layerSlots: [TRACK], layerTrackSlots: [TRACK] }).slots
    expect(slot.layers![0].anchorSec).toBeCloseTo(0, 5) // never before the file's start
    const later = [line("l0", 0, 2, { durationMs: 2_000 }), line("l1", 2, 5, { durationMs: 2_000 }, { durationMs: 1_000, targetOffsetMs: -400 })]
    const [, s1] = buildProgramme(later, { layerSlots: [TRACK], layerTrackSlots: [TRACK] }).slots
    expect(s1.layers![0].anchorSec).toBeCloseTo(-0.4, 5)
  })
})

// WHAT A HEAD TRIM DOES, in each timing (settled by AQU-2252, pinned here).
// The place is where the take's CLIP STARTS, never where its sound starts.
//   - Following the recordings, on the main track and on a voice track (a
//     track that sets line lengths), a head trim TIGHTENS the line: the sound
//     comes earlier and the pause before it is unchanged.
//   - On a layer, and on every track following the source, a head trim moves
//     only the take's left edge: the sound stays where it was.
describe("a head trim, in each timing (AQU-2267)", () => {
  // A 2 s take whose clip starts 0.5 s into its line following the recordings
  // and 0.25 s into it following the source; its head trimmed by 0.3 s or not.
  const take = (trimStartMs?: number): Take => ({
    durationMs: 2_000, targetOffsetMs: 250, recordingsOffsetMs: 500, ...(trimStartMs ? { trimStartMs } : {}),
  })
  const timed = (trim?: number) => [line("l0", 0, 3, { durationMs: 3_000 }), line("l1", 3, 6, take(trim))]
  const onTrack = (trim?: number) => [line("l0", 0, 3, { durationMs: 3_000 }), line("l1", 3, 6, { durationMs: 1_000 }, take(trim))]
  const geomOf = (mode: "dubbing" | "audioFirst", cells: CellData[], id: string, opts?: object) => {
    const g = buildTimelineLayout(mode, cells, cells, null, opts).targetGeom(cells[1], att(cells[1], id), id)!
    return { start: g.start, end: g.end }
  }

  describe("following the recordings", () => {
    it("on the main track: the sound comes earlier, the pause before it is unchanged, the line is shorter", () => {
      const before = buildProgramme(timed()).slots[1]
      const after = buildProgramme(timed(300)).slots[1]
      expect(before.targetLeadSec).toBeCloseTo(0.5, 5)
      expect(after.targetLeadSec).toBeCloseTo(0.5, 5)
      // It plays from 0.3 s into its clip, starting at the same moment.
      expect(after.targetWindow).toEqual({ start: 0.3, end: expect.closeTo(2, 5) })
      expect(before.slotLenSec - after.slotLenSec).toBeCloseTo(0.3, 5)
      const [b, a] = [geomOf("audioFirst", timed(), takeId("l1")), geomOf("audioFirst", timed(300), takeId("l1"))]
      expect(a.start).toBeCloseTo(b.start, 5)
      expect(b.end - a.end).toBeCloseTo(0.3, 5)
    })

    it("on a voice track (one that sets line lengths): the same", () => {
      const opts = { layerSlots: [TRACK] }
      const before = buildProgramme(onTrack(), opts).slots[1].layers![0]
      const after = buildProgramme(onTrack(300), opts).slots[1].layers![0]
      expect(after.atSec).toBeCloseTo(before.atSec, 5)
      expect(after.window).toEqual({ start: 0.3, end: expect.closeTo(2, 5) })
      const [b, a] = [geomOf("audioFirst", onTrack(), trackId("l1"), opts), geomOf("audioFirst", onTrack(300), trackId("l1"), opts)]
      expect(a.start).toBeCloseTo(b.start, 5)
      expect(b.end - a.end).toBeCloseTo(0.3, 5)
    })

    it("on a layer: only its left edge moves, its sound stays where it was", () => {
      const opts = { layerSlots: [TRACK], layerTrackSlots: [TRACK] }
      const before = buildProgramme(onTrack(), opts).slots[1].layers![0]
      const after = buildProgramme(onTrack(300), opts).slots[1].layers![0]
      expect(after.anchorSec).toBeCloseTo(before.anchorSec, 5)
      expect(after.atSec - before.atSec).toBeCloseTo(0.3, 5)
      const [b, a] = [geomOf("audioFirst", onTrack(), trackId("l1"), opts), geomOf("audioFirst", onTrack(300), trackId("l1"), opts)]
      expect(a.start - b.start).toBeCloseTo(0.3, 5)
      expect(a.end).toBeCloseTo(b.end, 5)
    })

    it("on a book's line, as on the main track", () => {
      const book = (trim?: number) => [verse("v0", { durationMs: 1_000 }), verse("v1", take(trim))]
      const before = buildProgramme(book(), { standInLenSec: () => 1 }).slots[1]
      const after = buildProgramme(book(300), { standInLenSec: () => 1 }).slots[1]
      expect(after.targetLeadSec).toBeCloseTo(before.targetLeadSec!, 5)
      expect(before.slotLenSec - after.slotLenSec).toBeCloseTo(0.3, 5)
    })
  })

  describe("following the source", () => {
    it("on the main track: only its left edge moves", () => {
      const [b, a] = [geomOf("dubbing", timed(), takeId("l1")), geomOf("dubbing", timed(300), takeId("l1"))]
      expect(a.start - b.start).toBeCloseTo(0.3, 5)
      expect(a.end).toBeCloseTo(b.end, 5)
      expect(b.start).toBeCloseTo(3.25, 5) // its place following the source
    })

    it("on an added track, voice or layer: the same", () => {
      for (const opts of [{ layerSlots: [TRACK] }, { layerSlots: [TRACK], layerTrackSlots: [TRACK] }]) {
        const [b, a] = [geomOf("dubbing", onTrack(), trackId("l1"), opts), geomOf("dubbing", onTrack(300), trackId("l1"), opts)]
        expect(a.start - b.start).toBeCloseTo(0.3, 5)
        expect(a.end).toBeCloseTo(b.end, 5)
      }
    })
  })
})
