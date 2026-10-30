import { describe, expect, it } from "vitest"
import {
  clampTrim,
  gainAt,
  joinsOf,
  lengthOf,
  mapWindow,
  placeSegments,
  segmentsOf,
  shiftTime,
  type EditOp,
} from "./edit-list"
import { applyClipMix, peakOf, renderSegments, viewPeaks } from "./render"
import { formatStationTime, parseStationTime, rulerStep, rulerTicks } from "./time"

// The working build's own walk (board 40b, test.js): a 3.64 s take, a part
// deleted, a pick-up inserted, a part kept.
describe("the Station's edit list", () => {
  const del: EditOp = { kind: "del", a: 1.0, b: 1.5 }
  const ins: EditOp = { kind: "ins", at: 2.0, src: "pick", len: 2.34, label: "Pick-up · line 334" }

  it("a delete closes the gap and leaves one join", () => {
    const segs = segmentsOf("take", 3.64, [del])
    expect(lengthOf(segs)).toBeCloseTo(3.14, 5)
    expect(joinsOf(placeSegments(segs))).toEqual([1.0])
  })

  it("an insert pushes what follows later and is marked as inserted", () => {
    const segs = segmentsOf("take", 3.64, [del, ins])
    expect(lengthOf(segs)).toBeCloseTo(3.14 + 2.34, 5)
    const placed = placeSegments(segs)
    const inserted = placed.find((g) => g.ins)
    expect(inserted).toMatchObject({ src: "pick", t0: 2.0 })
    expect(inserted!.t1).toBeCloseTo(4.34, 5)
    // The original after the insert resumes where it left off.
    const after = placed[placed.indexOf(inserted!) + 1]
    expect(after.src).toBe("take")
    expect(after.a).toBeCloseTo(2.5, 5)
  })

  it("an insert past the end goes at the end", () => {
    const segs = segmentsOf("take", 1, [{ kind: "ins", at: 5, src: "x", len: 0.5, label: "x" }])
    expect(lengthOf(segs)).toBeCloseTo(1.5, 5)
  })

  it("a trim keeps its sound through deletes and inserts", () => {
    // A delete before the end pulls it in; one inside lands where it was.
    expect(shiftTime(3.0, del)).toBeCloseTo(2.5, 5)
    expect(shiftTime(1.2, del)).toBe(1.0)
    expect(shiftTime(0.5, del)).toBe(0.5)
    // An insert before a moment moves it later; at the moment, it stays.
    expect(shiftTime(3.0, ins)).toBeCloseTo(5.34, 5)
    expect(shiftTime(2.0, ins)).toBe(2.0)
  })

  it("another placement's window keeps exactly the sound it had", () => {
    // A placement using only 0–0.9 s is untouched by edits after it.
    expect(mapWindow({ start: 0, end: 0.9 }, [del, ins])).toEqual({ start: 0, end: 0.9 })
    // One across the deleted part loses only that part.
    const w = mapWindow({ start: 0.5, end: 2.0 }, [del])
    expect(w.start).toBe(0.5)
    expect(w.end).toBeCloseTo(1.5, 5)
  })

  it("Start and End stay inside the recording and apart", () => {
    expect(clampTrim(-1, -1, 4)).toEqual({ trimA: 0, trimB: 4 })
    expect(clampTrim(3.99, 3.99, 4).trimB - clampTrim(3.99, 3.99, 4).trimA).toBeCloseTo(0.05, 5)
  })

  it("volume and fades shape the level inside the kept part", () => {
    const clip = { trimA: 1, trimB: 3, fadeIn: 0.5, fadeOut: 0.5, gainDb: -6 }
    expect(gainAt(1, clip)).toBe(0)
    expect(gainAt(1.25, clip)).toBeCloseTo(0.5 * Math.pow(10, -6 / 20), 5)
    expect(gainAt(2, clip)).toBeCloseTo(Math.pow(10, -6 / 20), 5)
    expect(gainAt(3, clip)).toBe(0)
  })
})

describe("the Station's samples", () => {
  const rate = 100
  const take = { data: Float32Array.from({ length: 300 }, (_, i) => (i < 100 ? 0.5 : i < 200 ? -1 : 0.25)), rate }
  const lookup = (src: string) => (src === "take" ? take : null)

  it("renders the edited recording as one buffer", () => {
    const placed = placeSegments(segmentsOf("take", 3, [{ kind: "del", a: 1, b: 2 }]))
    const out = renderSegments(placed, lookup, rate)
    expect(out.length).toBe(200)
    expect(out[50]).toBe(0.5)
    expect(out[150]).toBe(0.25)
  })

  it("the clip's mix keeps the kept part and applies the volume", () => {
    const out = applyClipMix(take.data, rate, { trimA: 1, trimB: 2, fadeIn: 0, fadeOut: 0, gainDb: 20 })
    expect(out.length).toBe(100)
    expect(out[10]).toBeCloseTo(-10, 4)
  })

  it("peaks are drawn against the take's loudest sample", () => {
    expect(peakOf(take.data)).toBe(1)
    const placed = placeSegments(segmentsOf("take", 3, []))
    const p = viewPeaks(placed, lookup, 0, 3, 3, 1)
    expect(Array.from(p)).toEqual([0.5, 1, 0.25])
  })
})

describe("the Station's times", () => {
  it("writes m:ss.cc", () => {
    expect(formatStationTime(4.2)).toBe("0:04.20")
    expect(formatStationTime(62.35)).toBe("1:02.35")
    expect(formatStationTime(59.999)).toBe("1:00.00")
    expect(formatStationTime(-1)).toBe("0:00.00")
  })

  it("reads what people type, or says it isn't a time", () => {
    expect(parseStationTime("1:02.35")).toBe(62.35)
    expect(parseStationTime("62.35")).toBe(62.35)
    expect(parseStationTime("0:04.2")).toBe(4.2)
    expect(parseStationTime("4,2")).toBe(4.2)
    expect(parseStationTime("abc")).toBeNull()
    expect(parseStationTime("1:75")).toBeNull()
  })

  it("the ruler's step follows the span, coarser for long recordings", () => {
    expect(rulerStep(0.5)).toBe(0.1)
    expect(rulerStep(4)).toBe(0.5)
    expect(rulerStep(600)).toBe(60)
    expect(rulerTicks(0, 1)).toEqual([0, 0.25, 0.5, 0.75, 1])
  })
})
