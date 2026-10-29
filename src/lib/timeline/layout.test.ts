// AQU-646 SUB-53 — the one place that answers "where does this go on the
// track?". Dubbing must keep returning the pre-SUB-53 geometry verbatim;
// audio-first returns the laid-out programme.

import { describe, expect, it } from "vitest"
import { buildTimelineLayout } from "./layout"
import { buildProgramme } from "./programme"
import { targetChipGeom, targetOffsetMsFor } from "./lane-timing"
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
  // v2: original 10s, translation 4s → slot 4s at 11: following the
  // recordings, only the take sets its length and the original is cut there
  // (AQU-2204, Sam Oct 27).
  const cells = [verse("v1", 0, 6, { durationMs: 11_000 }), verse("v2", 6, 16, { durationMs: 4_000 })]
  const layout = buildTimelineLayout("audioFirst", cells, cells)

  it("the original moves to its verse's slot, cut where the verse ends", () => {
    expect(layout.spanFor(cells[0], "source")).toEqual({ start: 0, end: 6 })
    // v2's original no longer starts at file second 6 — it waits for v1's
    // translation to finish — and it stops where v2's take does.
    expect(layout.spanFor(cells[1], "source")).toEqual({ start: 11, end: 15 })
  })

  it("the subtitle card covers the whole verse, so the text stays readable", () => {
    expect(layout.spanFor(cells[0], "subtitle")).toEqual({ start: 0, end: 11 })
    expect(layout.spanFor(cells[1], "subtitle")).toEqual({ start: 11, end: 15 })
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
    expect(layout.totalSec).toBe(15 + 2)
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
    expect(l.spanFor(sub, "subtitle")).toEqual({ start: 11, end: 15 })
  })
})

// AQU-646: a subtitle file timed against footage. Its last cue lands minutes
// before the episode ends, and everything past it used to be off the end of the
// scrollable track — on the demo episode, three minutes of it.
describe("dubbing layout — the footage's length is a floor on the track", () => {
  const subs = [
    { id: "c1", fileId: "f1", medium: "text", startTime: 41.792, endTime: 43.043 },
    { id: "c2", fileId: "f1", medium: "text", startTime: 4020, endTime: 4029.321 },
  ] as unknown as CellData[]

  it("reaches the end of the video, not the end of the last cue", () => {
    const l = buildTimelineLayout("dubbing", subs, [], 4212.096)
    expect(l.totalSec).toBeCloseTo(4212.096 + 2, 3)
  })

  it("falls back to the cues when the duration is not known yet", () => {
    for (const unknown of [undefined, null, 0, NaN, -1]) {
      const l = buildTimelineLayout("dubbing", subs, [], unknown as number | null)
      expect(l.totalSec).toBeCloseTo(4029.321 + 2, 3)
    }
  })

  it("never SHORTENS the track — a cue past the video's end still fits", () => {
    const overrun = [
      { id: "c1", fileId: "f1", medium: "text", startTime: 10, endTime: 500 },
    ] as unknown as CellData[]
    expect(buildTimelineLayout("dubbing", overrun, [], 120).totalSec).toBe(500 + 2)
  })

  it("leaves Free timing alone — the footage's clock means nothing there", () => {
    const l = buildTimelineLayout("audioFirst", subs, [], 4212.096)
    expect(l.totalSec).toBe(0 + 2) // no media cells → empty programme
  })
})

describe("video-less subtitle import (AQU-1704)", () => {
  // Three SRT cues, 0-3, 3-6, 6-9 s, each with a take: 1 s, 5 s, 2 s.
  const cue = (id: string, start: number, end: number, ms: number): CellData => {
    const takeId = `audio-${id}-1700000000-take.webm`
    return {
      id, fileId: "f1", original: "line", translated: "", medium: "text", startTime: start, endTime: end,
      selectedAudioId: takeId,
      attachments: { [takeId]: { type: "audio", url: "frontier-audio://take", durationMs: ms } },
    } as unknown as CellData
  }
  const cues = [cue("c1", 0, 3, 1_000), cue("c2", 3, 6, 5_000), cue("c3", 6, 9, 2_000)]
  const att = (c: CellData) => c.attachments?.[`audio-${c.id}-1700000000-take.webm`] as never

  it("audio-first lays the takes end to end: slots at 0, 1 and 6 s", () => {
    // The editor passes the subtitle lane as the programme source when the
    // dialogue lane is empty.
    const layout = buildTimelineLayout("audioFirst", cues, cues)
    expect(layout.programme?.slots.map((s) => s.startSec)).toEqual([0, 1, 6])
    expect(layout.programme?.totalSec).toBe(8)
    expect(layout.targetGeom(cues[0], att(cues[0]))).toMatchObject({ start: 0, end: 1 })
    expect(layout.targetGeom(cues[1], att(cues[1]))).toMatchObject({ start: 1, end: 6 })
    expect(layout.targetGeom(cues[2], att(cues[2]))).toMatchObject({ start: 6, end: 8 })
  })

  it("dubbing keeps the cue slots", () => {
    const layout = buildTimelineLayout("dubbing", cues, [])
    expect(layout.programme).toBeNull()
    expect(layout.targetGeom(cues[1], att(cues[1]))).toMatchObject({ start: 3 })
  })
})

// AQU-1767 (Sam, 2026-10-15): in Free timing a split take's pieces sit end to
// end in the line's slot, in recording order, the way its joined clip plays.
describe("audio-first layout — a split take", () => {
  it("places each piece right after the one before it", () => {
    const TAKE = "audio-a-1700000000-take.wav"
    const PIECE = "audio-a-1700000500-piece.wav"
    const cell = {
      id: "a", fileId: "f1", original: "", translated: "", medium: "media", startTime: 0, endTime: 2,
      selectedAudioId: TAKE,
      attachments: {
        [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000, trimStartMs: 200, trimEndMs: 1500 },
        [PIECE]: { type: "audio", url: "frontier-audio://take", slot: "recording", pieceOf: TAKE, durationMs: 4000, trimStartMs: 2500, trimEndMs: 3700 },
      },
    } as unknown as CellData
    const l = buildTimelineLayout("audioFirst", [cell], [cell])
    const first = l.targetGeom(cell, cell.attachments![TAKE] as never)!
    const second = l.targetGeom(cell, cell.attachments![PIECE] as never)!
    expect([first.start, first.end]).toEqual([0, expect.closeTo(1.3)] as never)
    expect(second.start).toBeCloseTo(1.3)
    expect(second.end).toBeCloseTo(2.5)
    // Its sample zero sits a head-trim before where it is drawn.
    expect(second.anchor).toBeCloseTo(1.3 - 2.5)
  })
})

// AQU-2215 (Sam, Oct 27, ETEN demo): a recorded take can still be moved when
// the file follows its recordings. `retimeAnchorSec` is `targetGeom`'s inverse
// for the one thing a drag may change, so what the chip was dropped on comes
// back as the FILE-clock anchor that is actually stored.
describe("moving a take — retimeAnchorSec / canRetimeTarget (AQU-2215)", () => {
  const placed = (offsetMs: number) => ({ durationMs: 3_000, targetOffsetMs: offsetMs }) as never

  describe("dubbing — the layout's clock IS the file clock", () => {
    const cells = [verse("v1", 0, 6, { durationMs: 11_000, trimStartMs: 500 })]
    const layout = buildTimelineLayout("dubbing", cells, cells)

    it("moves any chip, and stores the clip's sample zero a head-trim before the drop", () => {
      expect(layout.canRetimeTarget(cells[0], attOf(cells[0]))).toBe(true)
      expect(layout.retimeAnchorSec(cells[0], attOf(cells[0]), 4)).toBeCloseTo(3.5, 5)
    })
  })

  describe("following the recordings — what moves is the pause before the take", () => {
    // v1: original 0-2, take 3 s → slot 0-3. v2: original 2-4, take 3 s → slot 3-6.
    const cells = [verse("v1", 0, 2, { durationMs: 3_000 }), verse("v2", 2, 4, { durationMs: 3_000 })]
    const layout = buildTimelineLayout("audioFirst", cells, cells)

    it("stores a pause measured from the LINE's start, not the programme second dropped on", () => {
      // v2's line starts at programme second 3 and the file clock at 2. Dropped
      // at 4.2 → a 1.2 s pause → anchor 3.2 on the file clock, which is the
      // offset `targetOffsetMsFor` turns into +1200 ms.
      expect(layout.retimeAnchorSec(cells[1], attOf(cells[1]), 4.2)).toBeCloseTo(3.2, 5)
      // The programme second itself would have been stored as a 2.2 s pause —
      // the bug this inverse exists to prevent.
      expect(layout.retimeAnchorSec(cells[1], attOf(cells[1]), 4.2)).not.toBeCloseTo(4.2, 5)
    })

    it("dragging back to the line's start stores no pause at all", () => {
      // Line start (programme 3) → the cell's own start on the file clock.
      expect(layout.retimeAnchorSec(cells[1], attOf(cells[1]), 3)).toBeCloseTo(2, 5)
      // And further left clamps there rather than going negative.
      expect(layout.retimeAnchorSec(cells[1], attOf(cells[1]), 1)).toBeCloseTo(2, 5)
    })

    it("the pause it stores is the one the next layout draws the take at", () => {
      const moved = [verse("v1", 0, 2, placed(1_200)), verse("v2", 2, 4, { durationMs: 3_000 })]
      const after = buildTimelineLayout("audioFirst", moved, moved)
      const geom = after.targetGeom(moved[0], attOf(moved[0]))!
      expect(geom.start).toBeCloseTo(1.2, 5)
      expect(geom.end).toBeCloseTo(4.2, 5)
      // The line grew to hold the pause, so the line after it moved along.
      expect(after.programme!.byCellId.get("v2")!.startSec).toBeCloseTo(4.2, 5)
    })

    it("a take of unknown length is not movable — it has no placement to store", () => {
      const vague = [verse("v1", 0, 2, {})]
      const l = buildTimelineLayout("audioFirst", vague, vague)
      expect(l.canRetimeTarget(vague[0], attOf(vague[0]))).toBe(false)
      expect(l.retimeAnchorSec(vague[0], attOf(vague[0]), 1.5)).toBeNull()
    })

    // AQU-1758 (Sam's decision 3): each piece of a split take can be dragged;
    // where it lands is stored on the piece.
    it("a split take's pieces are movable, each stored on itself", () => {
      const TAKE = "audio-a-1700000000-take.wav"
      const PIECE = "audio-a-1700000500-piece.wav"
      const cell = {
        id: "a", fileId: "f1", original: "", translated: "", medium: "media", startTime: 0, endTime: 2,
        selectedAudioId: TAKE,
        attachments: {
          [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000, trimStartMs: 200, trimEndMs: 1500 },
          [PIECE]: { type: "audio", url: "frontier-audio://take", slot: "recording", pieceOf: TAKE, durationMs: 4000, trimStartMs: 2500, trimEndMs: 3700 },
        },
      } as unknown as CellData
      const l = buildTimelineLayout("audioFirst", [cell], [cell])
      expect(l.canRetimeTarget(cell, cell.attachments![TAKE] as never)).toBe(true)
      // The second piece, right after the first (1.3 s in), dragged to 1.8 s:
      // it moved 0.5 s, so its clip's start is now 0.5 s after the line's.
      expect(l.retimeAnchorSec(cell, cell.attachments![PIECE] as never, 1.8)).toBeCloseTo(0.5)
      // Drawn where it was placed.
      const placed = { ...cell, attachments: { ...cell.attachments, [PIECE]: { ...cell.attachments![PIECE], targetOffsetMs: 500 } } } as unknown as CellData
      const l2 = buildTimelineLayout("audioFirst", [placed], [placed])
      expect(l2.targetGeom(placed, placed.attachments![PIECE] as never)!.start).toBeCloseTo(1.8)
    })

    // AQU-1758 (Sam's decision 3): a Bible verse has no line start — the
    // pause is measured from its slot's start, stored on the take.
    it("a take on a line with no times moves its pause, stored from the slot's start", () => {
      const takeId = "audio-u-1700000000-take.webm"
      const first = { id: "x", fileId: "f1", original: "In the beginning", translated: "", medium: "text" } as unknown as CellData
      const cell = {
        id: "u", fileId: "f1", original: "", translated: "", medium: "text",
        selectedAudioId: takeId,
        attachments: { [takeId]: { type: "audio", url: "frontier-audio://take", durationMs: 3_000 } },
      } as unknown as CellData
      const l = buildTimelineLayout("audioFirst", [first, cell], [first, cell], null, { standInLenSec: () => 2 })
      expect(l.canRetimeTarget(cell, cell.attachments![takeId] as never)).toBe(true)
      // Its slot starts at 2 s (after the 2 s stand-in); dragged to 3.25 s.
      expect(l.retimeAnchorSec(cell, cell.attachments![takeId] as never, 3.25)).toBeCloseTo(1.25)
      // Dragged back before its slot: no pause.
      expect(l.retimeAnchorSec(cell, cell.attachments![takeId] as never, 1.5)).toBe(0)
    })
  })
})

// AQU-1758: a piece of a split take has ONE place, which both timings read —
// where its clip's start sits from its line's start. So a piece moved in one
// timing has moved by the same distance in the other.
describe("a piece of a split take, in both timings (AQU-1758)", () => {
  const TAKE = "audio-a-1700000000-take.wav"
  const PIECE = "audio-a-1700000500-piece.wav"
  /** A 6 s take on a line at 2–8 s, cut at 3 s: the second piece keeps the
   *  take's place (its clip's start on the line's) and starts 3 s into it. */
  const cut = (pieceOffsetMs?: number) =>
    ({
      id: "a", fileId: "f1", original: "", translated: "", medium: "media", startTime: 2, endTime: 8,
      selectedAudioId: TAKE,
      attachments: {
        [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 6000, trimEndMs: 3000 },
        [PIECE]: {
          type: "audio", url: "frontier-audio://take", slot: "recording", pieceOf: TAKE, durationMs: 6000, trimStartMs: 3000,
          ...(pieceOffsetMs != null ? { targetOffsetMs: pieceOffsetMs } : {}),
        },
        [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
      },
    }) as unknown as CellData
  const piece = (cell: CellData) => cell.attachments![PIECE] as never
  const recordings = (cell: CellData) => buildTimelineLayout("audioFirst", [cell], [cell])

  it("never moved, it follows the first piece, 3 s into its line, in both", () => {
    const cell = cut()
    expect(recordings(cell).targetGeom(cell, piece(cell))!.start).toBeCloseTo(3, 5)
    expect(targetChipGeom(cell, piece(cell))!.start - 2).toBeCloseTo(3, 5)
  })

  it("dragged to 4 s into its line following the recordings, it is 4 s in following the source too", () => {
    const cell = cut()
    const anchor = recordings(cell).retimeAnchorSec(cell, piece(cell), 4)!
    const moved = cut(targetOffsetMsFor(cell, anchor))
    expect(recordings(moved).targetGeom(moved, piece(moved))!.start).toBeCloseTo(4, 5)
    // Not 4 + its 3 s head: 7 s, over the line's last second.
    expect(targetChipGeom(moved, piece(moved))!.start - 2).toBeCloseTo(4, 5)
  })

  it("dragged 1 s later following the source, it leaves the same 1 s of silence following the recordings", () => {
    const cell = cut()
    const dubbing = buildTimelineLayout("dubbing", [cell], [cell])
    const anchor = dubbing.retimeAnchorSec(cell, piece(cell), 2 + 4)!
    const moved = cut(targetOffsetMsFor(cell, anchor))
    const [slot] = buildProgramme([moved]).slots
    expect(slot.targetPieces!.map((p) => [p.atSec, p.gapBeforeSec])).toEqual([[0, undefined], [4, expect.closeTo(1, 5)]])
  })

  it("dragged back over the first piece following the recordings, it stays against it and its place does not change", () => {
    const cell = cut()
    const anchor = recordings(cell).retimeAnchorSec(cell, piece(cell), 1.5)!
    // The place it already has: the lane records no move.
    expect(anchor).toBeCloseTo(targetChipGeom(cell, piece(cell))!.anchor, 5)
  })
})
