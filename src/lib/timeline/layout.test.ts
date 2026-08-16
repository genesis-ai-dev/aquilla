// AQU-646 SUB-53 — the one place that answers "where does this go on the
// track?". Dubbing must keep returning the pre-SUB-53 geometry verbatim;
// audio-first returns the laid-out programme.

import { describe, expect, it } from "vitest"
import { buildTimelineLayout } from "./layout"
import type { CellData } from "@/hooks/useCells"

const SOURCE_ID = "audio-f1-1690000000-shared.mp3"

function verse(
  id: string,
  startTime: number,
  endTime: number,
  take?: { durationMs?: number; trimStartMs?: number; trimEndMs?: number },
  over: Partial<CellData> = {},
): CellData {
  const takeId = `audio-${id}-1700000000-take.webm`
  return {
    id, fileId: "f1", original: "", translated: "", medium: "media", startTime, endTime,
    ...(take ? { selectedAudioId: takeId } : {}),
    attachments: {
      ...(take ? { [takeId]: { type: "audio", url: "frontier-audio://take", ...take } } : {}),
      [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
    },
    ...over,
  } as unknown as CellData
}

const attOf = (cell: CellData) =>
  cell.attachments?.[`audio-${cell.id}-1700000000-take.webm`] as
    | { durationMs?: number; trimStartMs?: number; trimEndMs?: number }
    | undefined

describe("dubbing layout — unchanged from before SUB-53", () => {
  const cells = [verse("v1", 0, 6, { durationMs: 11_000 }), verse("v2", 6, 16, { durationMs: 4_000 })]
  const layout = buildTimelineLayout("dubbing", cells, cells)

  it("cards sit at their real place in the imported file", () => {
    expect(layout.spanFor(cells[0], "source")).toEqual({ start: 0, end: 6 })
    expect(layout.spanFor(cells[1], "source")).toEqual({ start: 6, end: 16 })
    expect(layout.spanFor(cells[0], "subtitle")).toEqual({ start: 0, end: 6 })
  })

  it("a subtitle card with its own span still wins", () => {
    const moved = verse("v1", 0, 6, { durationMs: 1_000 }, { metadata: { subtitle_start_ms: 1500, subtitle_end_ms: 5500 } })
    const l = buildTimelineLayout("dubbing", [moved], [moved])
    expect(l.spanFor(moved, "subtitle")).toEqual({ start: 1.5, end: 5.5 })
  })

  it("a dub chip is clip-zero anchored at its section, and runs long where it does", () => {
    expect(layout.targetGeom(cells[0], attOf(cells[0]))).toMatchObject({ anchor: 0, start: 0, end: 11 })
    expect(layout.chipSection(cells[0], attOf(cells[0]))).toEqual({ start: 0, end: 6 })
  })

  it("the track is as long as the file, plus a little room", () => {
    expect(layout.totalSec).toBe(18)
  })

  it("clicking a card seeks to its file second", () => {
    expect(layout.seekSecFor(cells[1])).toBe(6)
  })
})

describe("audio-first layout — verses laid out end to end", () => {
  // v1: original 6s, translation 11s → slot 11s at 0.
  // v2: original 10s, translation 4s → slot 10s at 11.
  const cells = [verse("v1", 0, 6, { durationMs: 11_000 }), verse("v2", 6, 16, { durationMs: 4_000 })]
  const layout = buildTimelineLayout("audioFirst", cells, cells)

  it("the original keeps its real length but moves to its verse's slot", () => {
    expect(layout.spanFor(cells[0], "source")).toEqual({ start: 0, end: 6 })
    // v2's original no longer starts at file second 6 — it waits for v1's
    // translation to finish. This is the whole point.
    expect(layout.spanFor(cells[1], "source")).toEqual({ start: 11, end: 21 })
  })

  it("the subtitle card covers the whole verse, so the text stays readable", () => {
    expect(layout.spanFor(cells[0], "subtitle")).toEqual({ start: 0, end: 11 })
    expect(layout.spanFor(cells[1], "subtitle")).toEqual({ start: 11, end: 21 })
  })

  it("a verse's two sides share a left edge", () => {
    for (const cell of cells) {
      const src = layout.spanFor(cell, "source")!
      const dub = layout.targetGeom(cell, attOf(cell))!
      expect(dub.start).toBeCloseTo(src.start, 6)
    }
  })

  it("the chip is drawn at the translation's real length", () => {
    expect(layout.targetGeom(cells[0], attOf(cells[0]))).toMatchObject({ start: 0, end: 11 })
    expect(layout.targetGeom(cells[1], attOf(cells[1]))).toMatchObject({ start: 11, end: 15 })
  })

  it("nothing overlaps: every verse ends before the next begins", () => {
    const ends = cells.map((c) => {
      const src = layout.spanFor(c, "source")!
      const dub = layout.targetGeom(c, attOf(c))!
      return { start: src.start, end: Math.max(src.end, dub.end) }
    })
    for (let i = 1; i < ends.length; i++) {
      expect(ends[i].start).toBeGreaterThanOrEqual(ends[i - 1].end - 1e-9)
    }
  })

  it("a head-trimmed take keeps the EXISTING trim maths correct", () => {
    // The anchor sits a head-trim's worth before the slot start, so
    // TargetAudioLane's resize handlers (which measure against the anchor)
    // land on the same trim values they would in dubbing mode.
    const trimmed = [verse("v1", 0, 4, { durationMs: 9_000, trimStartMs: 2_000, trimEndMs: 8_000 })]
    const l = buildTimelineLayout("audioFirst", trimmed, trimmed)
    const g = l.targetGeom(trimmed[0], attOf(trimmed[0]))!
    expect(g.start).toBe(0) // audible start = the slot start
    expect(g.end).toBe(6) // 6s of audible audio
    expect(g.anchor).toBe(-2) // clip zero, 2s of head trim earlier
    // Dragging the right edge back to clip zero + trimEnd reproduces trimEnd:
    expect(Math.round((g.end - g.anchor) * 1000)).toBe(8_000)
    // …and the left edge likewise reproduces trimStart:
    expect(Math.round((g.start - g.anchor) * 1000)).toBe(2_000)
  })

  it("the chip's clamp starts at clip zero, so a head trim can be dragged back off", () => {
    const trimmed = [verse("v1", 0, 4, { durationMs: 9_000, trimStartMs: 2_000, trimEndMs: 8_000 })]
    const l = buildTimelineLayout("audioFirst", trimmed, trimmed)
    const att = attOf(trimmed[0])
    expect(l.chipSection(trimmed[0], att)).toEqual({ start: -2, end: 6 })
  })

  it("a take with no known length still says so, borrowing the original's width", () => {
    const unknown = [verse("v1", 0, 6, {})]
    const l = buildTimelineLayout("audioFirst", unknown, unknown)
    expect(l.targetGeom(unknown[0], attOf(unknown[0]))).toMatchObject({
      start: 0, end: 6, usingFallback: true, durationSec: null,
    })
  })

  it("the track is as long as the assembled passage", () => {
    expect(layout.totalSec).toBe(21 + 2)
  })

  it("clicking a card seeks to the verse's start on the programme clock", () => {
    expect(layout.seekSecFor(cells[0])).toBe(0)
    expect(layout.seekSecFor(cells[1])).toBe(11)
  })

  it("a subtitle cell that isn't itself a verse is moved along with the original", () => {
    // A real text subtitle cell in a mixed file: its timing is against the
    // imported recording, so it follows wherever that moment now sits.
    const sub = { id: "s1", fileId: "f1", medium: "text", startTime: 6, endTime: 16 } as unknown as CellData
    const l = buildTimelineLayout("audioFirst", [...cells, sub], cells)
    expect(l.spanFor(sub, "subtitle")).toEqual({ start: 11, end: 21 })
  })
})
