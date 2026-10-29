// AQU-2252: following the recordings, the takes on a line's tracks.
//
// Sam, Oct 28 (option A): the main track set each line's length, and a take on
// any other track was a LAYER with its own length, trim and place.
//
// Sam, Oct 29: that left a dramatised reading stuck — "recordings on new
// tracks can't take up space on their own. They require a recording in the
// first recording's track." So:
//   - EVERY track sets its lines' lengths by default, the main one and any
//     added one (a new track is most often another voice): a line lasts as
//     long as its longest take on any of them, each at its own place and
//     length, plus any pause before it;
//   - a track can be made a LAYER instead (music, sound effects, ambience):
//     its takes set no length and sit against their lines the way takes do
//     following the source — measured against the line, allowed a lead-in,
//     allowed to run past it;
//   - following the source, nothing changes.

import { describe, expect, it } from "vitest"
import { buildTimelineLayout } from "./layout"
import { buildProgramme, slotHasOwnSound, withoutHiddenTakes, type BuildProgrammeOptions } from "./programme"
import { targetOffsetMsFor } from "./lane-timing"
import type { CellData } from "@/hooks/useCells"

/** An added track's slot (its id). */
const TRACK = "01a17e67-ef58-74f7-a093-be935876197b"

type Take = { durationMs?: number; trimStartMs?: number; trimEndMs?: number; targetOffsetMs?: number }

const mainId = (id: string) => `audio-${id}-1700000000-main.wav`
const layerId = (id: string) => `audio-${id}-1700000500-layer.wav`

/** A line of a book with no times (Ruth): a main take and, optionally, a
 *  take on Track 1. */
function bookLine(id: string, main?: Take, layer?: Take, over: Partial<CellData> = {}): CellData {
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
    ...(main ? { selectedAudioId: mainId(id) } : {}),
    ...(layer ? { selectedBySlot: { [TRACK]: layerId(id) } } : {}),
    attachments: {
      ...(main ? { [mainId(id)]: { type: "audio", url: "frontier-audio://main", slot: "recording", ...main } } : {}),
      ...(layer ? { [layerId(id)]: { type: "audio", url: "frontier-audio://layer", slot: TRACK, ...layer } } : {}),
    },
    ...over,
  } as unknown as CellData
}

const att = (cell: CellData, id: string) => cell.attachments?.[id] as never

/**
 * Line 3 of the Ruth demo, in round numbers:
 *   l1: main 2 s                          → line 0 – 2
 *   l2: main 4 s trimmed to 1.0–3.9 s     → 2.9 s
 *       Track 1: 3.141 s trimmed to 0.841–2.896 (2.055 s), its sample zero
 *       placed 1 s into the line
 *   l3: main 2 s
 */
const TRACK_TAKE: Take = { durationMs: 3141, trimStartMs: 841, trimEndMs: 2896, targetOffsetMs: 1000 }
const ruth = (l1Ms = 2000, take: Take = TRACK_TAKE) => [
  bookLine("l1", { durationMs: l1Ms }),
  bookLine("l2", { durationMs: 4000, trimStartMs: 1000, trimEndMs: 3900 }, take),
  bookLine("l3", { durationMs: 2000 }),
]
const STAND_IN: BuildProgrammeOptions = { standInLenSec: () => 2 }
/** Track 1 made a layer. */
const AS_LAYER: BuildProgrammeOptions = { ...STAND_IN, layerTrackSlots: [TRACK] }
const layoutOf = (cells: CellData[], opts: BuildProgrammeOptions = STAND_IN) =>
  buildTimelineLayout("audioFirst", cells, cells, null, opts)
const layerLayoutOf = (cells: CellData[]) => layoutOf(cells, AS_LAYER)
const trackGeom = (cells: CellData[], opts: BuildProgrammeOptions = STAND_IN, i = 1) =>
  layoutOf(cells, opts).targetGeom(cells[i], att(cells[i], layerId(cells[i].id)), layerId(cells[i].id))!

describe("every track sets its lines' lengths by default (AQU-2252, Oct 29)", () => {
  it("a line recorded only on an added track takes that take's length, not its stand-in", () => {
    // Boaz's line: nothing on the main track, a 3 s take on Boaz's.
    const cells = [bookLine("l1", { durationMs: 2000 }), bookLine("l2", undefined, { durationMs: 3000 }), bookLine("l3", { durationMs: 2000 })]
    const prog = layoutOf(cells).programme!
    const l2 = prog.byCellId.get("l2")!
    expect(l2.slotLenSec).toBeCloseTo(3, 5)
    expect(l2.standIn).toBeUndefined()
    expect(prog.byCellId.get("l3")!.startSec).toBeCloseTo(5, 5)
    // …and the take sits where it was put, at its own length, inside its line.
    const geom = layoutOf(cells).targetGeom(cells[1], att(cells[1], layerId("l2")), layerId("l2"))!
    expect([geom.start, geom.end]).toEqual([expect.closeTo(2, 5), expect.closeTo(5, 5)])
  })

  it("two voices over each other on two tracks both fit: the line grows to the longer", () => {
    // Main take 2.9 s; Track 1's 2.055 s take starts 1 s into the line → 3.055 s.
    const prog = layoutOf(ruth()).programme!
    expect(prog.byCellId.get("l2")!.slotLenSec).toBeCloseTo(3.055, 5)
    expect(prog.byCellId.get("l3")!.startSec).toBeCloseTo(5.055, 5)
    // Track 1's take is the shorter: the main take's 2.9 s holds.
    const short = ruth(2000, { durationMs: 1000 })
    expect(layoutOf(short).programme!.byCellId.get("l2")!.slotLenSec).toBeCloseTo(2.9, 5)
  })

  it("an added track's take sits at its own pause and length, like the main take", () => {
    const geom = trackGeom(ruth())
    // The pause before it is where its clip's start was placed: 1 s into the line.
    expect([geom.start, geom.end]).toEqual([expect.closeTo(3, 5), expect.closeTo(5.055, 5)])
    expect(geom.anchor).toBeCloseTo(3 - 0.841, 5)
    expect(geom.usingFallback).toBe(false)
  })

  it("the main take on the same line is drawn exactly as before", () => {
    const cells = ruth()
    const main = layoutOf(cells).targetGeom(cells[1], att(cells[1], mainId("l2")), mainId("l2"))!
    expect([main.start, main.end]).toEqual([expect.closeTo(2, 5), expect.closeTo(4.9, 5)])
    expect(main.anchor).toBeCloseTo(1, 5)
  })

  it("moves inside its line, like the main take: dragging right grows the pause, never before the line's start", () => {
    const cells = ruth()
    const layout = layoutOf(cells)
    const a = att(cells[1], layerId("l2"))
    expect(layout.canRetimeTarget(cells[1], a, layerId("l2"))).toBe(true)
    expect(layout.retimeAnchorSec(cells[1], a, 4.5, layerId("l2"))).toBeCloseTo(2.5, 5)
    expect(layout.retimeAnchorSec(cells[1], a, 0.5, layerId("l2"))).toBeCloseTo(0, 5)
    // The pause a drag stores is the one the next layout draws.
    const moved = ruth(2000, { ...TRACK_TAKE, targetOffsetMs: 2500 })
    expect(trackGeom(moved).start).toBeCloseTo(4.5, 5)
  })

  it("is measured against its own line, which ends where the line does", () => {
    const cells = ruth()
    const section = layoutOf(cells).chipSection(cells[1], att(cells[1], layerId("l2")), layerId("l2"))!
    expect(section.start).toBeCloseTo(3 - 0.841, 5)
    expect(section.end).toBeCloseTo(2 + 3.055, 5)
  })

  it("a take whose length isn't known yet leaves its line its own length", () => {
    const cells = [bookLine("l1", { durationMs: 2000 }), bookLine("l2", undefined, {}), bookLine("l3", { durationMs: 2000 })]
    const layout = layoutOf(cells)
    expect(layout.programme!.byCellId.get("l2")!.slotLenSec).toBeCloseTo(2, 5)
    expect(layout.targetGeom(cells[1], att(cells[1], layerId("l2")), layerId("l2"))!.usingFallback).toBe(true)
    // …and a known one beside it sets the length on its own.
    const both = [bookLine("l1", { durationMs: 2000 }), bookLine("l2", { durationMs: 4000 }, {}), bookLine("l3", { durationMs: 2000 })]
    expect(layoutOf(both).programme!.byCellId.get("l2")!.slotLenSec).toBeCloseTo(4, 5)
  })

  it("a line with no take on any track that sets lengths keeps its stand-in", () => {
    const cells = [bookLine("l1", { durationMs: 2000 }), bookLine("l2"), bookLine("l3", { durationMs: 2000 })]
    const l2 = layoutOf(cells, { standInLenSec: () => 1.5 }).programme!.byCellId.get("l2")!
    expect(l2.slotLenSec).toBeCloseTo(1.5, 5)
    expect(l2.standIn).toBe(true)
  })

  it("on a timed line, its pause is its own anchor against the line's start", () => {
    // A line 10–14 s on the file clock; its main take 2 s; Track 1's 1.5 s
    // take placed 0.5 s after the line's start → the line lasts 2 s.
    const cell = {
      ...bookLine("t1", { durationMs: 2000 }, { durationMs: 1500, targetOffsetMs: 1000 }),
      startTime: 10, endTime: 14, medium: "media",
    } as unknown as CellData
    const layout = buildTimelineLayout("audioFirst", [cell], [cell], null, STAND_IN)
    const geom = layout.targetGeom(cell, att(cell, layerId("t1")), layerId("t1"))!
    expect([geom.start, geom.end]).toEqual([expect.closeTo(1, 5), expect.closeTo(2.5, 5)])
    expect(layout.programme!.byCellId.get("t1")!.slotLenSec).toBeCloseTo(2.5, 5)
  })

  it("knows the main take from an added track's", () => {
    const cells = ruth()
    const layout = layoutOf(cells)
    expect(layout.takeRole(cells[1], mainId("l2"))).toBe("main")
    expect(layout.takeRole(cells[1], layerId("l2"))).toBe("sets-length")
  })
})

describe("a track made a layer (AQU-2252, Oct 29)", () => {
  it("never sets its line's length — the other tracks do", () => {
    const layout = layerLayoutOf(ruth())
    expect(layout.programme!.byCellId.get("l2")!.slotLenSec).toBeCloseTo(2.9, 5)
    expect(layout.programme!.byCellId.get("l3")!.startSec).toBeCloseTo(4.9, 5)
    // A line with nothing but a layer keeps its stand-in.
    const only = [bookLine("l1", { durationMs: 2000 }), bookLine("l2", undefined, { durationMs: 9000 }), bookLine("l3", { durationMs: 2000 })]
    const l2 = layerLayoutOf(only).programme!.byCellId.get("l2")!
    expect(l2.slotLenSec).toBeCloseTo(2, 5)
    expect(l2.standIn).toBe(true)
  })

  it("is drawn at its own trimmed length, its sample zero at its own offset into its line", () => {
    const geom = trackGeom(ruth(), AS_LAYER)
    expect(geom.anchor).toBeCloseTo(3, 5)
    expect([geom.start, geom.end]).toEqual([expect.closeTo(3.841, 5), expect.closeTo(5.896, 5)])
    expect(geom.durationSec).toBeCloseTo(3.141, 5)
  })

  it("moves with its line when the line shifts", () => {
    expect(trackGeom(ruth(3000), AS_LAYER).start).toBeCloseTo(4.841, 5)
  })

  it("may run past its line's end, over the next line, which stays where it was", () => {
    const cells = ruth()
    const layout = layerLayoutOf(cells)
    const geom = layout.targetGeom(cells[1], att(cells[1], layerId("l2")), layerId("l2"))!
    const l2 = layout.programme!.byCellId.get("l2")!
    expect(geom.end).toBeGreaterThan(l2.startSec + l2.slotLenSec)
    expect(layout.programme!.byCellId.get("l3")!.startSec).toBeCloseTo(4.9, 5)
  })

  it("may start a little before its line — a lead-in — as it may following the source", () => {
    // Sample zero 1.5 s before line 2's start: it sounds from 1.341 s, in line 1.
    const geom = trackGeom(ruth(2000, { ...TRACK_TAKE, targetOffsetMs: -1500 }), AS_LAYER)
    expect(geom.start).toBeCloseTo(1.341, 5)
    expect(geom.end - geom.start).toBeCloseTo(2.055, 5)
  })

  it("never before the start of the file", () => {
    const cells = [bookLine("l1", { durationMs: 2000 }, { durationMs: 1000, targetOffsetMs: -800 })]
    const geom = trackGeom(cells, AS_LAYER, 0)
    expect(geom.start).toBeCloseTo(0, 5)
    expect(geom.end).toBeCloseTo(1, 5)
  })

  it("is measured against its line's slot, the way a take is measured against its line following the source", () => {
    const cells = ruth()
    const section = layerLayoutOf(cells).chipSection(cells[1], att(cells[1], layerId("l2")), layerId("l2"))!
    expect([section.start, section.end]).toEqual([expect.closeTo(2, 5), expect.closeTo(4.9, 5)])
  })

  it("a drag stores its own offset — before its line too, which the next layout draws as a lead-in", () => {
    const cells = ruth()
    const layout = layerLayoutOf(cells)
    const a = att(cells[1], layerId("l2"))
    expect(layout.canRetimeTarget(cells[1], a, layerId("l2"))).toBe(true)
    // Dropped so it sounds from 4.5 s: its sample zero 0.841 s earlier, 1.659 s into its line.
    expect(layout.retimeAnchorSec(cells[1], a, 4.5, layerId("l2"))).toBeCloseTo(1.659, 5)
    // Dropped so it sounds from 1.5 s, before its line's 2 s start.
    const stored = layout.retimeAnchorSec(cells[1], a, 1.5, layerId("l2"))!
    expect(stored).toBeCloseTo(-1.341, 5)
    // A line with no times has no file clock to fall off: the offset is kept as asked.
    expect(targetOffsetMsFor(cells[1], stored)).toBe(-1341)
    const back = ruth(2000, { ...TRACK_TAKE, targetOffsetMs: -1341 })
    expect(trackGeom(back, AS_LAYER).start).toBeCloseTo(1.5, 5)
  })

  it("a layer of unknown length can still be moved — its place is honest even if its length is not", () => {
    const cells = ruth(2000, { targetOffsetMs: 300 })
    const layout = layerLayoutOf(cells)
    const a = att(cells[1], layerId("l2"))
    const geom = layout.targetGeom(cells[1], a, layerId("l2"))!
    expect(geom.usingFallback).toBe(true)
    expect(geom.start).toBeCloseTo(2.3, 5)
    expect(layout.canRetimeTarget(cells[1], a, layerId("l2"))).toBe(true)
  })

  it("one past the last line plays out to its end: the file lengthens to reach it", () => {
    const cells = [bookLine("l1", { durationMs: 2000 }, { durationMs: 9000 })]
    const layout = layerLayoutOf(cells)
    expect(layout.programme!.byCellId.get("l1")!.slotLenSec).toBeCloseTo(2, 5)
    expect(layout.programme!.totalSec).toBeCloseTo(9, 5)
    expect(layout.totalSec).toBeGreaterThanOrEqual(9)
  })

  it("knows a layer from the main take", () => {
    const cells = ruth()
    const layout = layerLayoutOf(cells)
    expect(layout.takeRole(cells[1], layerId("l2"))).toBe("layer")
    expect(layout.takeRole(cells[1], mainId("l2"))).toBe("main")
  })
})

describe("the programme's takes on added tracks (AQU-2252)", () => {
  it("lists each on its line with its own window and place, and whether it sets the length", () => {
    const prog = buildProgramme(ruth(), STAND_IN)
    expect(prog.byCellId.get("l2")!.layers).toEqual([
      {
        slot: TRACK,
        audioId: layerId("l2"),
        atSec: expect.closeTo(1, 5),
        anchorSec: expect.closeTo(1 - 0.841, 5),
        window: { start: expect.closeTo(0.841, 5), end: expect.closeTo(2.896, 5) },
        setsLength: true,
      },
    ])
    expect(buildProgramme(ruth(), AS_LAYER).byCellId.get("l2")!.layers).toEqual([
      {
        slot: TRACK,
        audioId: layerId("l2"),
        atSec: expect.closeTo(1.841, 5),
        anchorSec: expect.closeTo(1, 5),
        window: { start: expect.closeTo(0.841, 5), end: expect.closeTo(2.896, 5) },
        setsLength: false,
      },
    ])
    expect(prog.byCellId.get("l1")!.layers).toBeUndefined()
  })

  it("a split take on an added track sets the length with every piece, each where it was placed", () => {
    const TAKE = "audio-l2-1700000500-take.wav"
    const PIECE = "audio-l2-1700000600-piece.wav"
    const cell = {
      ...bookLine("l2"),
      selectedBySlot: { [TRACK]: TAKE },
      attachments: {
        [TAKE]: { type: "audio", url: "frontier-audio://take", slot: TRACK, durationMs: 4000, trimStartMs: 200, trimEndMs: 1500 },
        // The second piece moved 0.7 s along from the end of the first (AQU-1758:
        // its clip's start 0.7 s after the line's): 2 s into the line.
        [PIECE]: { type: "audio", url: "frontier-audio://take", slot: TRACK, pieceOf: TAKE, durationMs: 4000, trimStartMs: 2500, trimEndMs: 3700, targetOffsetMs: 700 },
      },
    } as unknown as CellData
    const layout = layoutOf([cell])
    const slot = layout.programme!.byCellId.get("l2")!
    expect(slot.slotLenSec).toBeCloseTo(3.2, 5)
    expect(slot.layers!.map((l) => [l.audioId, l.atSec, l.setsLength])).toEqual([
      [TAKE, 0, true],
      [PIECE, expect.closeTo(2, 5), true],
    ])
    const piece = layout.targetGeom(cell, att(cell, PIECE), PIECE)!
    expect([piece.start, piece.end]).toEqual([expect.closeTo(2, 5), expect.closeTo(3.2, 5)])
  })

  // AQU-1758: a piece has ONE place, which both timings read — where its
  // clip's start sits from its line's start — on an added track as on the
  // main one. So a piece moved in one timing has moved as far in the other.
  describe("a piece of a split take on an added track, in both timings (AQU-1758)", () => {
    const TAKE = "audio-p1-1700000500-take.wav"
    const PIECE = "audio-p1-1700000600-piece.wav"
    /** A 6 s take on Track 1, on a line at 2–8 s, cut at 3 s: the second
     *  piece keeps the take's place and starts 3 s into the recording. */
    const cut = (pieceOffsetMs?: number) =>
      ({
        id: "p1", fileId: "f1", original: "", translated: "", medium: "media", startTime: 2, endTime: 8,
        selectedBySlot: { [TRACK]: TAKE },
        attachments: {
          [TAKE]: { type: "audio", url: "frontier-audio://take", slot: TRACK, durationMs: 6000, trimEndMs: 3000 },
          [PIECE]: {
            type: "audio", url: "frontier-audio://take", slot: TRACK, pieceOf: TAKE, durationMs: 6000, trimStartMs: 3000,
            ...(pieceOffsetMs != null ? { targetOffsetMs: pieceOffsetMs } : {}),
          },
        },
      }) as unknown as CellData
    const recordings = (cell: CellData) => buildTimelineLayout("audioFirst", [cell], [cell], null, STAND_IN)
    const source = (cell: CellData) => buildTimelineLayout("dubbing", [cell], [cell])

    it("never moved, it follows the first piece, 3 s into its line, in both", () => {
      const cell = cut()
      expect(recordings(cell).targetGeom(cell, att(cell, PIECE), PIECE)!.start).toBeCloseTo(3, 5)
      expect(source(cell).targetGeom(cell, att(cell, PIECE), PIECE)!.start - 2).toBeCloseTo(3, 5)
    })

    it("dragged to 4 s into its line following the recordings, it is 4 s in following the source too", () => {
      const cell = cut()
      const anchor = recordings(cell).retimeAnchorSec(cell, att(cell, PIECE), 4, PIECE)!
      const moved = cut(targetOffsetMsFor(cell, anchor))
      expect(recordings(moved).targetGeom(moved, att(moved, PIECE), PIECE)!.start).toBeCloseTo(4, 5)
      // Not 4 + its 3 s head: 7 s, over the line's last second.
      expect(source(moved).targetGeom(moved, att(moved, PIECE), PIECE)!.start - 2).toBeCloseTo(4, 5)
    })

    it("dragged back over the first piece following the recordings, its place does not change", () => {
      const cell = cut()
      const anchor = recordings(cell).retimeAnchorSec(cell, att(cell, PIECE), 1.5, PIECE)!
      expect(anchor).toBeCloseTo(source(cell).targetGeom(cell, att(cell, PIECE), PIECE)!.anchor, 5)
    })
  })

  it("plays only the tracks it is told to", () => {
    const prog = buildProgramme(ruth(), { ...STAND_IN, layerSlots: ["recording"] })
    expect(prog.byCellId.get("l2")!.layers).toBeUndefined()
    // …and a track it is not told about sets no length either.
    expect(prog.byCellId.get("l2")!.slotLenSec).toBeCloseTo(2.9, 5)
  })

  it("a hidden line's takes on other tracks are taken out with its own; its length stays", () => {
    const prog = withoutHiddenTakes(buildProgramme(ruth(), STAND_IN), new Set(["l2"]))
    expect(prog.byCellId.get("l2")!.layers).toBeUndefined()
    expect(prog.byCellId.get("l2")!.slotLenSec).toBeCloseTo(3.055, 5)
  })

  it("a line whose only take is on an added track has something of its own to play, whatever the track", () => {
    const cells = [bookLine("l1", { durationMs: 2000 }), bookLine("l2", undefined, { durationMs: 3000 }), bookLine("l3")]
    for (const opts of [STAND_IN, AS_LAYER]) {
      const prog = buildProgramme(cells, opts)
      expect(slotHasOwnSound(prog.byCellId.get("l1")!)).toBe(true)
      expect(slotHasOwnSound(prog.byCellId.get("l2")!)).toBe(true)
      expect(slotHasOwnSound(prog.byCellId.get("l3")!)).toBe(false)
    }
  })
})

describe("following the source, nothing changes (AQU-2252)", () => {
  const timed = () => [
    { ...bookLine("t1", { durationMs: 2000 }, { durationMs: 1500, targetOffsetMs: 500 }), startTime: 10, endTime: 14, medium: "media" },
    { ...bookLine("t2", { durationMs: 2000 }, { durationMs: 6000, targetOffsetMs: -300 }), startTime: 14, endTime: 16, medium: "media" },
  ] as unknown as CellData[]

  it("a take on an added track is drawn on the file clock as it always was", () => {
    const cells = timed()
    const layout = buildTimelineLayout("dubbing", cells, cells)
    expect(layout.targetGeom(cells[0], att(cells[0], layerId("t1")), layerId("t1"))).toMatchObject({ anchor: 10.5, start: 10.5, end: 12 })
    expect(layout.takeRole(cells[0], layerId("t1"))).toBeNull()
  })

  it("whether a track sets its lines' lengths makes no difference there at all", () => {
    const cells = timed()
    const plain = buildTimelineLayout("dubbing", cells, cells, 30, STAND_IN)
    const layered = buildTimelineLayout("dubbing", cells, cells, 30, AS_LAYER)
    expect(layered.totalSec).toBe(plain.totalSec)
    expect(layered.programme).toBeNull()
    for (const cell of cells) {
      for (const id of [mainId(cell.id), layerId(cell.id)]) {
        const a = att(cell, id)
        expect(layered.targetGeom(cell, a, id)).toEqual(plain.targetGeom(cell, a, id))
        expect(layered.chipSection(cell, a, id)).toEqual(plain.chipSection(cell, a, id))
        expect(layered.canRetimeTarget(cell, a, id)).toBe(plain.canRetimeTarget(cell, a, id))
        expect(layered.retimeAnchorSec(cell, a, 13, id)).toBe(plain.retimeAnchorSec(cell, a, 13, id))
        expect(layered.spanFor(cell, "source")).toEqual(plain.spanFor(cell, "source"))
      }
    }
  })
})
