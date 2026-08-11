// AQU-646: pure planners behind file-timeline seeking + seamless same-clip
// advance. Imported media files are ONE shared clip windowed per cell, so
// seeking and advancing are cell-location math — tested here without any
// Audio element (same style as play-queue.trim.test.ts).

import { describe, expect, it } from "vitest"
import { findCellAtTime, planSeek, planAdvance } from "./play-queue"
import type { CellData } from "@/hooks/useCells"

const CLIP = "frontier-audio://clip-1.mp3"
const OTHER = "frontier-audio://take-9.webm"

let nextId = 0
const mediaCell = (startTime: number, endTime: number, url: string = CLIP): CellData =>
  ({
    id: `c${++nextId}`, fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "text", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    medium: "media", startTime, endTime,
    selectedAudioId: "a1",
    attachments: { a1: { type: "audio", url } },
  }) as CellData

const textCell = (over: Partial<CellData> = {}): CellData =>
  ({
    id: `c${++nextId}`, fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "text", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    selectedAudioId: "t1",
    attachments: { t1: { type: "audio", url: OTHER } },
    ...over,
  }) as CellData

const noAudioCell = (startTime: number, endTime: number): CellData =>
  ({
    id: `c${++nextId}`, fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "text", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    medium: "media", startTime, endTime,
  }) as CellData

// Round 5: a DUBBED section — a cellId-seeded take is selected, but the
// shared source clip is still attached. The master element keeps playing the
// source clip, so this cell must behave exactly like a plain source section
// for location/seek/advance math.
const dubbedCell = (startTime: number, endTime: number): CellData => {
  const id = `c${++nextId}`
  const takeId = `audio-${id}-1700000000-take.webm`
  return {
    id, fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "text", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    medium: "media", startTime, endTime,
    selectedAudioId: takeId,
    attachments: {
      [takeId]: { type: "audio", url: `frontier-audio://take-${id}.webm` },
      "audio-f1-1690000000-shared.mp3": { type: "audio", url: CLIP },
    },
  } as CellData
}

// A tiled imported file: three sections partitioning [0, 30).
const tiled = [mediaCell(0, 10), mediaCell(10, 22), mediaCell(22, 30)]
// A legacy (pre-tiling) file: gaps between windows.
const gappy = [mediaCell(0.5, 8), mediaCell(9.2, 15), mediaCell(17, 24)]

describe("findCellAtTime", () => {
  it("returns the cell whose [start, end) window contains the time", () => {
    expect(findCellAtTime(tiled, 5)).toBe(0)
    expect(findCellAtTime(tiled, 15)).toBe(1)
    expect(findCellAtTime(tiled, 29.9)).toBe(2)
  })

  it("a shared tiled boundary belongs to the LATER cell", () => {
    expect(findCellAtTime(tiled, 10)).toBe(1)
    expect(findCellAtTime(tiled, 22)).toBe(2)
  })

  it("a legacy gap resolves to the FOLLOWING cell", () => {
    expect(findCellAtTime(gappy, 8.5)).toBe(1) // between window 0 and 1
    expect(findCellAtTime(gappy, 16)).toBe(2)
  })

  it("returns -1 past the last window", () => {
    expect(findCellAtTime(tiled, 30)).toBe(-1)
    expect(findCellAtTime(gappy, 25)).toBe(-1)
  })

  it("skips unplayable and non-windowed cells", () => {
    const cells = [noAudioCell(0, 10), textCell(), mediaCell(10, 20)]
    expect(findCellAtTime(cells, 5)).toBe(2) // first two can't own the time
  })

  it("a DUBBED section still owns its file-time span (round 5)", () => {
    const cells = [mediaCell(0, 10), dubbedCell(10, 22), mediaCell(22, 30)]
    expect(findCellAtTime(cells, 15)).toBe(1)
  })
})

describe("planSeek", () => {
  it("same cell → element-local seek", () => {
    expect(planSeek(tiled, 1, CLIP, 15)).toEqual({ kind: "element", index: 1, seconds: 15 })
  })

  it("different cell, same shared clip → seamless adopt", () => {
    expect(planSeek(tiled, 0, CLIP, 25)).toEqual({ kind: "seamless", index: 2, seconds: 25 })
  })

  it("different clip → open", () => {
    const cells = [textCell(), ...tiled]
    // Currently playing the text cell's own take (index 0), seeking into the media windows.
    expect(planSeek(cells, 0, OTHER, 15)).toEqual({ kind: "open", index: 2, seconds: 15 })
  })

  it("no owning window: a non-media current take falls back to element seek", () => {
    const cells = [textCell()]
    expect(planSeek(cells, 0, OTHER, 99)).toEqual({ kind: "element", index: 0, seconds: 99 })
  })

  it("no owning window and a windowed current cell → none", () => {
    expect(planSeek(tiled, 1, CLIP, 99)).toEqual({ kind: "none" })
  })

  it("seek into a DUBBED section is seamless on the shared source clip (round 5)", () => {
    const cells = [mediaCell(0, 10), dubbedCell(10, 22)]
    expect(planSeek(cells, 0, CLIP, 15)).toEqual({ kind: "seamless", index: 1, seconds: 15 })
  })
})

describe("planAdvance", () => {
  it("end of queue → stop", () => {
    expect(planAdvance(tiled, 2, CLIP, 30)).toEqual({ kind: "stop" })
  })

  it("contiguous tiled boundary → seamless with NO seek (audio flows through)", () => {
    expect(planAdvance(tiled, 0, CLIP, 10.01)).toEqual({ kind: "seamless", index: 1 })
  })

  it("legacy gap → seamless with NO seek (gap audio plays through — migration-free fix)", () => {
    expect(planAdvance(gappy, 0, CLIP, 8.02)).toEqual({ kind: "seamless", index: 1 })
  })

  it("genuinely overlapping next window (beyond the rewind tolerance) rewinds to its start", () => {
    const overlapping = [mediaCell(0, 10), mediaCell(8, 16)]
    expect(planAdvance(overlapping, 0, CLIP, 10.01)).toEqual({ kind: "seamless", index: 1, seekTo: 8 })
  })

  it("timeupdate overshoot skips ultra-short windows already passed", () => {
    const cells = [mediaCell(0, 10), mediaCell(10, 10.05), mediaCell(10.05, 20)]
    // The ~250ms tick lands at 10.3 — window 1 is fully behind us.
    expect(planAdvance(cells, 0, CLIP, 10.3)).toEqual({ kind: "seamless", index: 2 })
  })

  it("next cell on a DIFFERENT clip → open", () => {
    const cells = [mediaCell(0, 10), textCell()]
    expect(planAdvance(cells, 0, CLIP, 10.01)).toEqual({ kind: "open", index: 1 })
  })

  it("skips cells without playable audio", () => {
    const cells = [mediaCell(0, 10), noAudioCell(10, 22), mediaCell(22, 30)]
    expect(planAdvance(cells, 0, CLIP, 10.01)).toEqual({ kind: "seamless", index: 2 })
  })

  it("advance into a DUBBED section stays seamless on the source clip, NOT an element swap to the take (round 5)", () => {
    const cells = [mediaCell(0, 10), dubbedCell(10, 22)]
    expect(planAdvance(cells, 0, CLIP, 10.01)).toEqual({ kind: "seamless", index: 1 })
  })
})
