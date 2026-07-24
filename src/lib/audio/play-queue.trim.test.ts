import { describe, expect, it } from "vitest"
import { sameClipContinuation, trimWindowForCell } from "./play-queue"
import type { CellData } from "@/hooks/useCells"

const baseCell = (over: Partial<CellData>): CellData =>
  ({
    id: "c1", fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "text", status: "empty", validationStatus: "unvalidated",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    ...over,
  }) as CellData

// A media segment sharing an imported clip: same attachment url, own window.
const seg = (id: string, url: string, start: number, end: number): CellData =>
  baseCell({
    id,
    medium: "media",
    startTime: start,
    endTime: end,
    selectedAudioId: "a",
    attachments: { a: { url, type: "audio/mpeg" } },
  } as Partial<CellData>)

// WHY (AQU mp3 "unusable"): a media import splits ONE audio file into N cells,
// each attaching the SAME clip with a per-cell [startTime, endTime) window.
// The transport queue used to ignore those windows and play the entire file
// once per cell — an 8s file with 3 segments played ~24s of audio, all of it
// from 0:00. The queue must honor the window for media segments, and must NOT
// seek ordinary per-cell recordings (whose startTime/endTime are subtitle
// timings on a video timeline, unrelated to the recording's own clock).
describe("trimWindowForCell", () => {
  it("returns the window for a media segment with timing", () => {
    expect(
      trimWindowForCell(baseCell({ medium: "media", startTime: 2.9, endTime: 5 })),
    ).toEqual({ start: 2.9, end: 5 })
  })

  it("returns null for text cells even when subtitle timings exist", () => {
    expect(
      trimWindowForCell(baseCell({ medium: "text", startTime: 120, endTime: 125 })),
    ).toBeNull()
    expect(trimWindowForCell(baseCell({ startTime: 120, endTime: 125 }))).toBeNull()
  })

  it("returns null for media segments without a usable window", () => {
    expect(trimWindowForCell(baseCell({ medium: "media" }))).toBeNull()
    expect(trimWindowForCell(baseCell({ medium: "media", startTime: 3 }))).toBeNull()
    // Degenerate/inverted windows are ignored rather than trapping playback.
    expect(
      trimWindowForCell(baseCell({ medium: "media", startTime: 5, endTime: 5 })),
    ).toBeNull()
    expect(
      trimWindowForCell(baseCell({ medium: "media", startTime: 6, endTime: 5 })),
    ).toBeNull()
  })
})

// WHY (AQU-666): the bottom playback bar tore down and rebuilt the <audio>
// element at every section boundary, so the file audibly cut between sections
// instead of playing through. The queue now keeps ONE element running while the
// next section is another window on the SAME clip. sameClipContinuation is the
// decision at each window end: continue on this element, or hand off a fresh one.
describe("sameClipContinuation", () => {
  const clip = "https://cdn/colossians.mp3"

  it("returns the next window when the next section shares the clip", () => {
    const cells = [seg("s0", clip, 0, 3), seg("s1", clip, 3, 6), seg("s2", clip, 6, 9)]
    expect(sameClipContinuation(cells, 0, clip)).toEqual({ index: 1, trim: { start: 3, end: 6 } })
    expect(sameClipContinuation(cells, 1, clip)).toEqual({ index: 2, trim: { start: 6, end: 9 } })
  })

  it("returns null at the end of the clip's segments", () => {
    const cells = [seg("s0", clip, 0, 3), seg("s1", clip, 3, 6)]
    expect(sameClipContinuation(cells, 1, clip)).toBeNull()
  })

  it("returns null when the next section is a different clip", () => {
    const other = "https://cdn/philippians.mp3"
    const cells = [seg("s0", clip, 0, 3), seg("s1", other, 0, 3)]
    expect(sameClipContinuation(cells, 0, clip)).toBeNull()
  })

  it("returns null when the next cell is not a windowed media segment", () => {
    const cells = [
      seg("s0", clip, 0, 3),
      baseCell({ id: "t1", medium: "text", selectedAudioId: "a", attachments: { a: { url: clip, type: "audio/mpeg" } } } as Partial<CellData>),
    ]
    expect(sameClipContinuation(cells, 0, clip)).toBeNull()
  })

  it("skips over an unplayable cell to the next same-clip segment", () => {
    const cells = [
      seg("s0", clip, 0, 3),
      baseCell({ id: "gap", medium: "media", startTime: 3, endTime: 6 }), // no attachment → unplayable
      seg("s2", clip, 6, 9),
    ]
    expect(sameClipContinuation(cells, 0, clip)).toEqual({ index: 2, trim: { start: 6, end: 9 } })
  })
})
