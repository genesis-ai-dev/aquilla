// AQU-646 round 6: edge snapping — pure span transforms.

import { describe, expect, it } from "vitest"
import { snapSpan } from "./snap"

describe("snapSpan — move", () => {
  it("shifts the whole span when the start edge is near a candidate", () => {
    expect(snapSpan({ start: 10.1, end: 14.1 }, "move", [10], 0.2)).toEqual({ start: 10, end: 14, snapped: "start" })
  })
  it("shifts by the END edge when it is the closer hit", () => {
    expect(snapSpan({ start: 10.4, end: 14.05 }, "move", [10, 14], 0.2)).toEqual({ start: 10.35, end: 14, snapped: "end" })
  })
  it("closest candidate wins for one edge", () => {
    expect(snapSpan({ start: 9.93, end: 13.93 }, "move", [9.8, 10], 0.2).start).toBeCloseTo(10)
  })
  it("no candidates in range → identity", () => {
    expect(snapSpan({ start: 10.5, end: 14.5 }, "move", [20], 0.2)).toEqual({ start: 10.5, end: 14.5, snapped: null })
  })
  it("empty candidates / zero threshold → identity", () => {
    expect(snapSpan({ start: 1, end: 2 }, "move", [], 0.2).snapped).toBeNull()
    expect(snapSpan({ start: 1, end: 2 }, "move", [1], 0).snapped).toBeNull()
  })
})

describe("snapSpan — resize", () => {
  it("resize-l adjusts only the start", () => {
    expect(snapSpan({ start: 10.1, end: 14 }, "resize-l", [10], 0.2)).toEqual({ start: 10, end: 14, snapped: "start" })
  })
  it("resize-r adjusts only the end", () => {
    expect(snapSpan({ start: 10, end: 13.9 }, "resize-r", [14], 0.2)).toEqual({ start: 10, end: 14, snapped: "end" })
  })
  it("resize edges ignore candidates near the OTHER edge", () => {
    expect(snapSpan({ start: 10.1, end: 14 }, "resize-r", [10], 0.2).snapped).toBeNull()
  })
})
