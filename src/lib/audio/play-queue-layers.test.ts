// AQU-2252: the layer schedule the transport asks on every 60 ms beat. Its
// searches must answer exactly what a walk of every layer would — they only
// look at fewer of them.

import { describe, expect, it } from "vitest"
import { buildLayerSchedule, layerIndexAfter, layersDueAt, layersSoundIn, NO_LAYERS, type LayerSchedule } from "./play-queue-layers"
import { buildProgramme } from "@/lib/timeline/programme"
import type { CellData } from "@/hooks/useCells"

const TRACK = "trk-1"

/** A line with a main take and a take on Track 1, a layer. */
function line(id: string, mainMs: number, layer: { durationMs: number; targetOffsetMs: number }): CellData {
  const mainId = `audio-${id}-1700000000-main.webm`
  const layerId = `audio-${id}-1700000500-layer.webm`
  return {
    id, fileId: "f1", original: `${id} words`, translated: "", medium: "text",
    selectedAudioId: mainId,
    selectedBySlot: { [TRACK]: layerId },
    attachments: {
      [mainId]: { type: "audio", url: `http://audio.test/${id}.webm`, slot: "recording", durationMs: mainMs },
      [layerId]: { type: "audio", url: `http://audio.test/${id}-layer.webm`, slot: TRACK, ...layer },
    },
  } as unknown as CellData
}

/** Forty lines of uneven lengths, their layers of very uneven lengths and
 *  places: a long bed every so often, short effects between. */
function book(): CellData[] {
  let seed = 7
  const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  return Array.from({ length: 40 }, (_, i) =>
    line(`l${i}`, 300 + Math.round(next() * 1700), {
      durationMs: i % 9 === 0 ? 12000 + Math.round(next() * 8000) : 200 + Math.round(next() * 1500),
      targetOffsetMs: Math.round(next() * 1200) - 300,
    }),
  )
}

const scheduleOf = (cells: CellData[]): LayerSchedule =>
  buildLayerSchedule(buildProgramme(cells, { standInLenSec: () => 1, layerTrackSlots: [TRACK] }), cells)

describe("the layer schedule (AQU-2252)", () => {
  const s = scheduleOf(book())

  it("holds every playable layer, soonest first, each with its line", () => {
    expect(s.layers).toHaveLength(40)
    for (let i = 1; i < s.layers.length; i++) expect(s.layers[i].startSec).toBeGreaterThanOrEqual(s.layers[i - 1].startSec)
    for (const l of s.layers) expect(l.cell.id).toBe(l.cellId)
    expect(s.maxLenSec).toBeGreaterThan(12)
  })

  it("answers what sounds at a moment exactly as a walk of all of them does", () => {
    const end = s.layers[s.layers.length - 1].endSec + 1
    for (let at = -1; at < end; at += 0.137) {
      const walked = s.layers.filter((l) => l.startSec - 0.012 <= at && at < l.endSec)
      expect(layersDueAt(s, at, 0.012)).toEqual(walked)
    }
  })

  it("answers whether anything sounds in a stretch exactly as a walk does", () => {
    const end = s.layers[s.layers.length - 1].endSec + 1
    for (let from = -1; from < end; from += 0.29) {
      for (const len of [0, 0.05, 0.4, 3, Infinity]) {
        const walked = s.layers.some((l) => l.startSec < from + len && l.endSec > from)
        expect(layersSoundIn(s, from, from + len)).toBe(walked)
      }
    }
  })

  it("finds the first layer starting after a moment, or at it", () => {
    const at = s.layers[10].startSec
    expect(s.layers[layerIndexAfter(s, at)].startSec).toBeGreaterThan(at)
    expect(s.layers[layerIndexAfter(s, at, true)].startSec).toBe(at)
    expect(layerIndexAfter(s, Infinity)).toBe(s.layers.length)
    expect(layerIndexAfter(s, -Infinity)).toBe(0)
  })

  it("is empty with no programme, and with nothing honest to play", () => {
    expect(buildLayerSchedule(null, book())).toBe(NO_LAYERS)
    const unmeasured = book().map((c) => {
      const atts = Object.fromEntries(
        Object.entries(c.attachments ?? {}).map(([id, a]) => [id, id.includes("-layer") ? { ...a, durationMs: undefined } : a]),
      )
      return { ...c, attachments: atts } as CellData
    })
    expect(scheduleOf(unmeasured).layers).toHaveLength(0)
    expect(layersDueAt(NO_LAYERS, 3, 0.012)).toEqual([])
    expect(layersSoundIn(NO_LAYERS, 0, Infinity)).toBe(false)
  })
})
