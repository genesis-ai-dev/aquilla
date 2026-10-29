// AQU-2252 (Sam, Oct 28, option A): following the recordings, a take on any
// track but the language's main one is a LAYER. The main track still sets each
// line's length; a layer keeps its own length, its own trim and its own place —
// an offset from its line's start — moves with its line, and may run on past
// the line's end over the next one, like a music bed or a second voice.
//
// Before this, every take on a line was drawn from the line's slot, which is
// built from the MAIN take alone: a 2.9 s main take made Track 1's take 2.9 s
// long, a trim sprang back to that length, and a drag went nowhere.

import { describe, expect, it } from "vitest"
import { buildTimelineLayout } from "./layout"
import { buildProgramme, withoutHiddenTakes } from "./programme"
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
 *   l2: main 4 s trimmed to 1.0–3.9 s     → line 2 – 4.9 (the 2.9 s Sam saw)
 *       Track 1: 3.141 s trimmed to 0.841–2.896 (2.055 s), its sample zero
 *       placed 1 s into the line          → sounds 3.841 – 5.896
 *   l3: main 2 s                          → line 4.9 – 6.9
 */
const LAYER_TAKE: Take = { durationMs: 3141, trimStartMs: 841, trimEndMs: 2896, targetOffsetMs: 1000 }
const ruth = (l1Ms = 2000, layer: Take = LAYER_TAKE) => [
  bookLine("l1", { durationMs: l1Ms }),
  bookLine("l2", { durationMs: 4000, trimStartMs: 1000, trimEndMs: 3900 }, layer),
  bookLine("l3", { durationMs: 2000 }),
]
const layoutOf = (cells: CellData[]) =>
  buildTimelineLayout("audioFirst", cells, cells, null, { standInLenSec: () => 2 })

describe("a take on an added track keeps its own length (AQU-2252)", () => {
  it("is drawn at its own trimmed length, not its line's", () => {
    const cells = ruth()
    const geom = layoutOf(cells).targetGeom(cells[1], att(cells[1], layerId("l2")), layerId("l2"))!
    expect(geom.end - geom.start).toBeCloseTo(2.055, 5)
    expect(geom.usingFallback).toBe(false)
    expect(geom.durationSec).toBeCloseTo(3.141, 5)
  })

  it("never sets its line's length — the main take still does", () => {
    const layout = layoutOf(ruth())
    const slot = layout.programme!.byCellId.get("l2")!
    expect(slot.slotLenSec).toBeCloseTo(2.9, 5)
    expect(layout.programme!.byCellId.get("l3")!.startSec).toBeCloseTo(4.9, 5)
  })

  it("the main take on the same line is drawn exactly as before", () => {
    const cells = ruth()
    const main = layoutOf(cells).targetGeom(cells[1], att(cells[1], mainId("l2")), mainId("l2"))!
    expect([main.start, main.end]).toEqual([expect.closeTo(2, 5), expect.closeTo(4.9, 5)])
    expect(main.anchor).toBeCloseTo(1, 5)
  })
})

describe("a layer starts where it was put (AQU-2252)", () => {
  it("its clip's sample zero sits its own offset into its line, its sound a head trim later", () => {
    const cells = ruth()
    const geom = layoutOf(cells).targetGeom(cells[1], att(cells[1], layerId("l2")), layerId("l2"))!
    expect(geom.anchor).toBeCloseTo(3, 5)
    expect(geom.start).toBeCloseTo(3.841, 5)
    expect(geom.end).toBeCloseTo(5.896, 5)
  })

  it("moves with its line when the line shifts", () => {
    // l1's take grows by a second; l2 starts a second later, and so does its layer.
    const cells = ruth(3000)
    const geom = layoutOf(cells).targetGeom(cells[1], att(cells[1], layerId("l2")), layerId("l2"))!
    expect(geom.start).toBeCloseTo(4.841, 5)
  })

  it("may run past its line's end, over the next line, which stays where it was", () => {
    const layout = layoutOf(ruth())
    const cells = ruth()
    const geom = layout.targetGeom(cells[1], att(cells[1], layerId("l2")), layerId("l2"))!
    const l2 = layout.programme!.byCellId.get("l2")!
    expect(geom.end).toBeGreaterThan(l2.startSec + l2.slotLenSec)
    expect(layout.programme!.byCellId.get("l3")!.startSec).toBeCloseTo(4.9, 5)
  })

  it("never sounds before its line's start, whatever offset it carries", () => {
    const cells = ruth(2000, { ...LAYER_TAKE, targetOffsetMs: -5000 })
    const geom = layoutOf(cells).targetGeom(cells[1], att(cells[1], layerId("l2")), layerId("l2"))!
    expect(geom.start).toBeCloseTo(2, 5)
    expect(geom.end - geom.start).toBeCloseTo(2.055, 5)
  })

  it("a fresh take nobody has placed starts on its line", () => {
    const cells = ruth(2000, { durationMs: 3000 })
    const geom = layoutOf(cells).targetGeom(cells[1], att(cells[1], layerId("l2")), layerId("l2"))!
    expect([geom.start, geom.end]).toEqual([expect.closeTo(2, 5), expect.closeTo(5, 5)])
  })

  it("on a timed line, its place is its own anchor against the line's start", () => {
    // A line 10–14 s on the file clock; its main take 2 s; the layer's sample
    // zero placed 0.5 s after the line's start.
    const cell = {
      ...bookLine("t1", { durationMs: 2000 }, { durationMs: 1500, targetOffsetMs: 500 }),
      startTime: 10, endTime: 14, medium: "media",
    } as unknown as CellData
    const layout = buildTimelineLayout("audioFirst", [cell], [cell], null, { standInLenSec: () => 2 })
    const geom = layout.targetGeom(cell, att(cell, layerId("t1")), layerId("t1"))!
    expect([geom.start, geom.end]).toEqual([expect.closeTo(0.5, 5), expect.closeTo(2, 5)])
  })

  it("the track reaches a layer that runs past the last line", () => {
    const cells = [bookLine("l1", { durationMs: 2000 }, { durationMs: 9000 })]
    const layout = layoutOf(cells)
    expect(layout.programme!.totalSec).toBeCloseTo(2, 5)
    expect(layout.totalSec).toBeGreaterThanOrEqual(9)
  })
})

describe("trimming and moving a layer (AQU-2252)", () => {
  it("its trim reaches out to its whole recording, never back before its line", () => {
    const cells = ruth()
    const section = layoutOf(cells).chipSection(cells[1], att(cells[1], layerId("l2")), layerId("l2"))!
    // From its sample zero (inside the line) to the end of the recording.
    expect(section.start).toBeCloseTo(3, 5)
    expect(section.end).toBeCloseTo(3 + 3.141, 5)
    // Placed so its head trim reaches back past the line's start: the trim stops there.
    const early = ruth(2000, { ...LAYER_TAKE, targetOffsetMs: -500 })
    const clamp = layoutOf(early).chipSection(early[1], att(early[1], layerId("l2")), layerId("l2"))!
    expect(clamp.start).toBeCloseTo(2, 5)
  })

  it("can be moved, and the drag stores its own offset — the sample zero a head trim before where it was dropped", () => {
    const cells = ruth()
    const layout = layoutOf(cells)
    const a = att(cells[1], layerId("l2"))
    expect(layout.canRetimeTarget(cells[1], a, layerId("l2"))).toBe(true)
    // Dropped so it sounds from 4.5 s: 2.5 s into its line, less its 0.841 s head trim.
    expect(layout.retimeAnchorSec(cells[1], a, 4.5, layerId("l2"))).toBeCloseTo(1.659, 5)
  })

  it("the offset a drag stores is where the next layout draws it", () => {
    const moved = ruth(2000, { ...LAYER_TAKE, targetOffsetMs: 1659 })
    const geom = layoutOf(moved).targetGeom(moved[1], att(moved[1], layerId("l2")), layerId("l2"))!
    expect(geom.start).toBeCloseTo(4.5, 5)
    expect(geom.end - geom.start).toBeCloseTo(2.055, 5)
  })

  it("dragging it before its line's start stops at the line's start", () => {
    const cells = ruth()
    const layout = layoutOf(cells)
    const stored = layout.retimeAnchorSec(cells[1], att(cells[1], layerId("l2")), 0.5, layerId("l2"))!
    expect(stored).toBeCloseTo(-0.841, 5)
    // A line with no times has no file clock to fall off: the offset is kept as asked.
    expect(targetOffsetMsFor(cells[1], stored)).toBe(-841)
    const back = ruth(2000, { ...LAYER_TAKE, targetOffsetMs: -841 })
    expect(layoutOf(back).targetGeom(back[1], att(back[1], layerId("l2")), layerId("l2"))!.start).toBeCloseTo(2, 5)
  })

  it("a layer of unknown length can still be moved — its place is honest even if its length is not", () => {
    const cells = ruth(2000, { targetOffsetMs: 300 })
    const layout = layoutOf(cells)
    const a = att(cells[1], layerId("l2"))
    const geom = layout.targetGeom(cells[1], a, layerId("l2"))!
    expect(geom.usingFallback).toBe(true)
    expect(geom.start).toBeCloseTo(2.3, 5)
    expect(layout.canRetimeTarget(cells[1], a, layerId("l2"))).toBe(true)
  })

  it("knows a layer from the main take", () => {
    const cells = ruth()
    const layout = layoutOf(cells)
    expect(layout.isLayerTake(cells[1], layerId("l2"))).toBe(true)
    expect(layout.isLayerTake(cells[1], mainId("l2"))).toBe(false)
  })
})

describe("the programme's layers (AQU-2252)", () => {
  it("lists each layer on its line with its own window and place", () => {
    const prog = buildProgramme(ruth(), { standInLenSec: () => 2 })
    expect(prog.byCellId.get("l2")!.layers).toEqual([
      {
        slot: TRACK,
        audioId: layerId("l2"),
        atSec: expect.closeTo(1.841, 5),
        anchorSec: expect.closeTo(1, 5),
        window: { start: expect.closeTo(0.841, 5), end: expect.closeTo(2.896, 5) },
      },
    ])
    expect(prog.byCellId.get("l1")!.layers).toBeUndefined()
  })

  it("plays only the tracks it is told to", () => {
    const prog = buildProgramme(ruth(), { standInLenSec: () => 2, layerSlots: ["recording"] })
    expect(prog.byCellId.get("l2")!.layers).toBeUndefined()
  })

  it("a hidden line's layers are taken out with its take", () => {
    const prog = withoutHiddenTakes(buildProgramme(ruth(), { standInLenSec: () => 2 }), new Set(["l2"]))
    expect(prog.byCellId.get("l2")!.layers).toBeUndefined()
  })
})

describe("following the original, nothing changes (AQU-2252)", () => {
  it("a take on an added track is drawn on the file clock as it always was", () => {
    const cell = {
      ...bookLine("t1", { durationMs: 2000 }, { durationMs: 1500, targetOffsetMs: 500 }),
      startTime: 10, endTime: 14, medium: "media",
    } as unknown as CellData
    const layout = buildTimelineLayout("dubbing", [cell], [cell])
    expect(layout.targetGeom(cell, att(cell, layerId("t1")), layerId("t1"))).toMatchObject({ anchor: 10.5, start: 10.5, end: 12 })
    expect(layout.isLayerTake(cell, layerId("t1"))).toBe(false)
  })
})
