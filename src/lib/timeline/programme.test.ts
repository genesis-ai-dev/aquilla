// AQU-646 SUB-53 — the audio-first layout. Every verse takes as much room as
// its longer side, laid end to end, and the two sides share a left edge.

import { describe, expect, it } from "vitest"
import {
  buildProgramme,
  cellStartProgrammeSec,
  programmeLines,
  programmeToSource,
  programmeToTarget,
  slotAtProgrammeSec,
  slotForCell,
  sourceFileSecToProgramme,
  targetRatio,
  withoutHiddenTakes,
  type Programme,
} from "./programme"
import type { CellData } from "@/hooks/useCells"

const SOURCE_ID = "audio-f1-1690000000-shared.mp3"

/** A dubbed media section: source clip attached, plus a selected take. */
function verse(
  id: string,
  startTime: number,
  endTime: number,
  take?: { durationMs?: number; trimStartMs?: number; trimEndMs?: number },
  over: Partial<CellData> = {},
): CellData {
  const takeId = `audio-${id}-1700000000-take.webm`
  return {
    id,
    fileId: "f1",
    original: "",
    translated: "",
    medium: "media",
    startTime,
    endTime,
    ...(take ? { selectedAudioId: takeId } : {}),
    attachments: {
      ...(take ? { [takeId]: { type: "audio", url: "frontier-audio://take", ...take } } : {}),
      [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
    },
    ...over,
  } as unknown as CellData
}

describe("buildProgramme — laying the verses out", () => {
  it("a verse whose translation runs long pushes the next one right", () => {
    // v1: original 0-6 (6s), translation 11s  → slot 11s
    // v2: original 6-10 (4s), translation 7s  → slot 7s, starting at 11
    const prog = buildProgramme([
      verse("v1", 0, 6, { durationMs: 11_000 }),
      verse("v2", 6, 10, { durationMs: 7_000 }),
    ])
    expect(prog.slots.map((s) => [s.cellId, s.startSec, s.slotLenSec])).toEqual([
      ["v1", 0, 11],
      ["v2", 11, 7],
    ])
    expect(prog.totalSec).toBe(18)
  })

  // AQU-2204 (Sam, Oct 27): "Make 'Follows recordings' really follow the
  // recordings." Free timing used to give the line the longer of the two.
  it("a line is as long as its take even when the original runs longer — the original is cut where the line ends (AQU-2204)", () => {
    const prog = buildProgramme([verse("v1", 0, 9, { durationMs: 4_000 }), verse("v2", 9, 12, { durationMs: 2_000 })])
    expect(prog.slots[0]).toMatchObject({ sourceLenSec: 4, targetLenSec: 4, slotLenSec: 4, cardLenSec: 4, clock: "target" })
    expect(prog.slots[0].sourceWindow).toEqual({ start: 0, end: 4 })
    expect(prog.slots[1].startSec).toBe(4)
  })

  it("a line with no take takes its stand-in length, not its original's (AQU-2204)", () => {
    const prog = buildProgramme([verse("v1", 0, 9), verse("v2", 9, 12, { durationMs: 2_000 })], { standInLenSec: () => 2.5 })
    expect(prog.slots[0]).toMatchObject({ slotLenSec: 2.5, sourceLenSec: 2.5, clock: "source", standIn: true })
    expect(prog.slots[1].startSec).toBe(2.5)
  })

  it("the TRANSLATION clocks the slot when it is the longer side", () => {
    const prog = buildProgramme([verse("v1", 0, 4, { durationMs: 9_000 })])
    expect(prog.slots[0]).toMatchObject({ sourceLenSec: 4, targetLenSec: 9, slotLenSec: 9, clock: "target" })
  })

  it("a verse with no dub yet takes just its original's length", () => {
    const prog = buildProgramme([verse("v1", 0, 6), verse("v2", 6, 10, { durationMs: 3_000 })])
    expect(prog.slots[0]).toMatchObject({ targetLenSec: 0, slotLenSec: 6, clock: "source", targetWindow: null })
    expect(prog.slots[1].startSec).toBe(6)
  })

  it("trims shorten the slot — trimming a take pulls everything after it left", () => {
    const full = buildProgramme([
      verse("v1", 0, 4, { durationMs: 12_000 }),
      verse("v2", 4, 8, { durationMs: 3_000 }),
    ])
    expect(full.slots[1].startSec).toBe(12)
    const trimmed = buildProgramme([
      verse("v1", 0, 4, { durationMs: 12_000, trimStartMs: 1_000, trimEndMs: 6_000 }),
      verse("v2", 4, 8, { durationMs: 3_000 }),
    ])
    expect(trimmed.slots[0]).toMatchObject({ targetLenSec: 5, slotLenSec: 5 })
    expect(trimmed.slots[1].startSec).toBe(5)
    // v2 is as long as its 3 s take (AQU-2204), not its 4 s original.
    expect(trimmed.totalSec).toBe(8)
  })

  it("a take whose length isn't known borrows the original's, and gets no playback window", () => {
    const prog = buildProgramme([verse("v1", 0, 6, {})])
    expect(prog.slots[0]).toMatchObject({
      sourceLenSec: 6,
      targetLenSec: 6,
      slotLenSec: 6,
      targetWindow: null,
      clock: "source",
    })
  })

  it("skips sections with no usable timing — they belong in the Untimed strip", () => {
    const prog = buildProgramme([
      verse("v1", 0, 5, { durationMs: 5_000 }),
      verse("bad", Number.NaN, 10, { durationMs: 2_000 }),
      verse("v2", 5, 9, { durationMs: 4_000 }),
    ])
    expect(prog.slots.map((s) => s.cellId)).toEqual(["v1", "v2"])
    expect(prog.slots[1].startSec).toBe(5)
  })

  it("a take-only section (source clip gone) is clocked by its take", () => {
    const takeId = "audio-v1-1700000000-take.webm"
    const cell = {
      id: "v1", fileId: "f1", medium: "media", startTime: 0, endTime: 6,
      selectedAudioId: takeId,
      attachments: { [takeId]: { type: "audio", url: "frontier-audio://take", durationMs: 9_000 } },
    } as unknown as CellData
    expect(buildProgramme([cell]).slots[0]).toMatchObject({ clock: "target", sourceWindow: null, slotLenSec: 9 })
  })

  it("a verse with NO original audio is only as long as its translation", () => {
    // Found in the browser: a section whose source clip is gone but which has
    // a generated voice. Sizing its verse by the section's nominal span left a
    // stretch that nothing could play — so the clock had to skip it, which is
    // the one thing this layout exists to avoid.
    const genId = "audio-v1-1700000000-gen.wav"
    const orphan = {
      id: "v1", fileId: "f1", medium: "media", startTime: 0, endTime: 4.89,
      selectedGeneratedVoiceAudioId: genId,
      attachments: { [genId]: { type: "audio", url: "frontier-audio://gen", durationMs: 3_000 } },
    } as unknown as CellData
    const prog = buildProgramme([orphan, verse("v2", 5, 9, { durationMs: 2_000 })])
    expect(prog.slots[0]).toMatchObject({
      sourceLenSec: 0, // nothing to hear
      targetLenSec: 3,
      slotLenSec: 3, // …so the verse is exactly as long as the voice
      cardLenSec: 3, // and its card says so rather than claiming 4.89s
      clock: "target",
    })
    expect(prog.slots[1].startSec).toBe(3)
    // Every moment of the verse is covered by audio — nothing to skip.
    expect(prog.slots[0].slotLenSec).toBe(prog.slots[0].targetLenSec)
  })

  it("a verse with nothing playable at all keeps its own length and is skipped", () => {
    const silent = { id: "v0", fileId: "f1", medium: "media", startTime: 0, endTime: 4 } as unknown as CellData
    const prog = buildProgramme([silent, verse("v2", 4, 8, { durationMs: 2_000 })])
    expect(prog.slots[0]).toMatchObject({ slotLenSec: 4, clock: null, sourceWindow: null, targetWindow: null })
    expect(prog.slots[1].startSec).toBe(4)
  })

  it("empty input is an empty programme", () => {
    expect(buildProgramme([])).toMatchObject({ slots: [], totalSec: 0 })
  })
})

describe("looking a position up", () => {
  const prog = buildProgramme([
    verse("v1", 0, 6, { durationMs: 11_000 }), // slot 0→11: original 6s, translation 11s
    verse("v2", 6, 16, { durationMs: 4_000 }), // slot 11→15: the translation's 4s; the original is cut there (AQU-2204)
  ])

  it("finds the verse a programme second falls in", () => {
    expect(slotAtProgrammeSec(prog, 0)?.cellId).toBe("v1")
    expect(slotAtProgrammeSec(prog, 10.9)?.cellId).toBe("v1")
    expect(slotAtProgrammeSec(prog, 11)?.cellId).toBe("v2")
    expect(slotAtProgrammeSec(prog, 14.9)?.cellId).toBe("v2")
  })

  it("past the end, or before the start, is nothing", () => {
    expect(slotAtProgrammeSec(prog, 15)).toBeNull()
    expect(slotAtProgrammeSec(prog, -1)).toBeNull()
    expect(slotAtProgrammeSec(prog, Number.NaN)).toBeNull()
  })

  it("both sides start together at the top of a verse", () => {
    expect(programmeToSource(prog, 0)).toMatchObject({ clipSec: 0 })
    expect(programmeToTarget(prog, 0)).toMatchObject({ clipSec: 0 })
    expect(programmeToSource(prog, 11)).toMatchObject({ clipSec: 6 })
    expect(programmeToTarget(prog, 11)).toMatchObject({ clipSec: 0 })
  })

  it("the SHORTER side falls silent for the rest of the verse", () => {
    // v1's original runs out after 6s; the translation keeps going to 11s.
    expect(programmeToSource(prog, 5.9)).toMatchObject({ clipSec: 5.9 })
    expect(programmeToSource(prog, 6)).toBeNull()
    expect(programmeToSource(prog, 10.9)).toBeNull()
    expect(programmeToTarget(prog, 10.9)).toMatchObject({ clipSec: 10.9 })
    // v2's original runs longer than its translation, so it is cut where the
    // translation ends (AQU-2204): both stop at 4 s.
    expect(programmeToTarget(prog, 11 + 3.9)?.clipSec).toBeCloseTo(3.9, 6)
    expect(programmeToSource(prog, 11 + 3.9)?.clipSec).toBeCloseTo(9.9, 6)
    expect(programmeToTarget(prog, 11 + 4)).toBeNull()
    expect(programmeToSource(prog, 11 + 4)).toBeNull()
  })

  it("a head trim joins the clip past the trim", () => {
    const trimmed = buildProgramme([verse("v1", 0, 4, { durationMs: 9_000, trimStartMs: 2_000 })])
    // Effective length 7s; the audible audio starts 2s into the clip.
    expect(trimmed.slots[0]).toMatchObject({ targetLenSec: 7, slotLenSec: 7 })
    expect(programmeToTarget(trimmed, 0)).toMatchObject({ clipSec: 2 })
    expect(programmeToTarget(trimmed, 6.9)).toMatchObject({ clipSec: 8.9 })
    expect(programmeToTarget(trimmed, 7)).toBeNull()
  })

  it("maps a file second back onto the programme clock", () => {
    expect(sourceFileSecToProgramme(prog, 0)).toBe(0)
    expect(sourceFileSecToProgramme(prog, 5)).toBe(5)
    // v2's original starts at file second 6 — now shown at programme second 11.
    expect(sourceFileSecToProgramme(prog, 6)).toBe(11)
    expect(sourceFileSecToProgramme(prog, 9)).toBe(14)
    // Past the take's end the original is cut, so it isn't on the programme.
    expect(sourceFileSecToProgramme(prog, 15)).toBeNull()
    expect(sourceFileSecToProgramme(prog, 99)).toBeNull()
  })

  it("round-trips a source position through both directions", () => {
    for (const fileSec of [0, 3.25, 6, 8, 9.75]) {
      const prog2 = sourceFileSecToProgramme(prog, fileSec)!
      expect(programmeToSource(prog, prog2)?.clipSec).toBeCloseTo(fileSec, 6)
    }
  })

  it("finds a verse's start and its slot by id", () => {
    expect(cellStartProgrammeSec(prog, "v2")).toBe(11)
    expect(cellStartProgrammeSec(prog, "nope")).toBeNull()
    expect(slotForCell(prog, "v1")?.slotLenSec).toBe(11)
    expect(slotForCell(prog, "nope")).toBeNull()
  })
})

describe("targetRatio — the honest replacement for the overflow warnings", () => {
  it("reports how the translation compares to the original", () => {
    const prog = buildProgramme([verse("v1", 0, 6, { durationMs: 11_000 })])
    expect(targetRatio(prog.slots[0])).toBeCloseTo(11 / 6, 6)
  })
  it("null when there is nothing to compare", () => {
    const prog = buildProgramme([verse("v1", 0, 6)])
    expect(targetRatio(prog.slots[0])).toBeNull()
  })
})

describe("source-window contiguity (pre-merge round)", () => {
  it("adjacent tiled cells produce EXACTLY contiguous source windows — no rounding", () => {
    // The seek-free boundary advance (planFreeSourceAdvance) relies on this:
    // during continuous playback the source element ends verse N sitting
    // exactly where verse N+1's window begins, so no seek is ever needed.
    // buildProgramme must keep copying startTime/endTime verbatim.
    const cells = [
      verse("v1", 0, 6.123456789),
      verse("v2", 6.123456789, 10.5),
      verse("v3", 10.5, 16.000000001),
    ]
    const prog = buildProgramme(cells)
    for (let i = 0; i < prog.slots.length - 1; i++) {
      expect(prog.slots[i].sourceWindow!.end).toBe(prog.slots[i + 1].sourceWindow!.start)
    }
  })
})

// AQU-1767 (Sam, 2026-10-15): Free timing plays a split take as one take —
// its pieces back to back, joined into one clip.
describe("buildProgramme — a split take", () => {
  const TAKE = "audio-a-1700000000-take.wav"
  const PIECE = "audio-a-1700000500-piece.wav"
  const split = (pieceMs?: number) =>
    verse("a", 0, 2, undefined, {
      selectedAudioId: TAKE,
      attachments: {
        [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 4000, trimStartMs: 200, trimEndMs: 1500 },
        [PIECE]: { type: "audio", url: "frontier-audio://take", slot: "recording", pieceOf: TAKE, durationMs: pieceMs, trimStartMs: 2500, ...(pieceMs ? { trimEndMs: 3700 } : {}) },
        [SOURCE_ID]: { type: "audio", url: "frontier-audio://src" },
      },
    } as unknown as Partial<CellData>)

  it("sizes the line by every piece and plays them as one joined clip", () => {
    const [slot] = buildProgramme([split(4000)]).slots
    // 1.3s + 1.2s; the second spends 1s between them in the recording, unheard.
    expect(slot.targetLenSec).toBeCloseTo(2.5)
    expect(slot.slotLenSec).toBeCloseTo(2.5)
    expect(slot.targetWindow).toEqual({ start: 0, end: 2.5 })
    expect(slot.targetPieces).toEqual([
      { audioId: TAKE, start: 0.2, end: 1.5 },
      { audioId: PIECE, start: 2.5, end: 3.7 },
    ])
  })

  it("falls back to the first piece while a piece's length is unknown", () => {
    const [slot] = buildProgramme([split(undefined)]).slots
    expect(slot.targetPieces).toBeUndefined()
    expect(slot.targetLenSec).toBeCloseTo(1.3)
    expect(slot.targetWindow).toEqual({ start: 0.2, end: 1.5 })
  })
})

// Sam's decision (hidden lines on the timeline): in Free timing a hidden verse
// keeps its place, sounds only its original, and with none is stepped over.
describe("withoutHiddenTakes", () => {
  it("keeps every verse's place but takes a hidden verse's take out of what plays", () => {
    const prog = {
      totalSec: 20,
      byCellId: new Map(),
      slots: [
        { cellId: "a", startSec: 0, sourceLenSec: 4, targetLenSec: 6, nominalLenSec: 4, cardLenSec: 4, slotLenSec: 6, clock: "target", sourceWindow: { start: 0, end: 4 }, targetWindow: { start: 0, end: 6 } },
        { cellId: "b", startSec: 6, sourceLenSec: 0, targetLenSec: 3, nominalLenSec: 4, cardLenSec: 3, slotLenSec: 3, clock: "target", sourceWindow: null, targetWindow: { start: 0, end: 3 } },
        { cellId: "c", startSec: 9, sourceLenSec: 0, targetLenSec: 3, nominalLenSec: 4, cardLenSec: 3, slotLenSec: 3, clock: "target", sourceWindow: null, targetWindow: { start: 0, end: 3 } },
      ],
    } as unknown as Programme
    const out = withoutHiddenTakes(prog, new Set(["a", "b"]))
    expect(out.slots.map((s) => [s.cellId, s.startSec, s.slotLenSec])).toEqual([["a", 0, 6], ["b", 6, 3], ["c", 9, 3]])
    expect(out.byCellId.get("a")).toMatchObject({ targetWindow: null, clock: "source" })
    expect(out.byCellId.get("b")).toMatchObject({ targetWindow: null, clock: null })
    expect(out.byCellId.get("c")).toBe(prog.slots[2])
  })
})

// AQU-2204 (Sam, Oct 26): a file with NO times at all (an audio Bible book)
// following its recordings lays its lines out in order — each at its
// recording's length, or a stand-in from its text.
describe("lines with no times (AQU-2204)", () => {
  const untimed = (id: string, takeMs?: number, seq = 0): CellData => {
    const takeId = `audio-${id}-take.webm`
    return {
      id,
      fileId: "f1",
      original: id,
      translated: "",
      medium: "text",
      sequenceIndex: seq,
      ...(takeMs != null ? { selectedAudioId: takeId } : {}),
      attachments: takeMs != null ? { [takeId]: { type: "audio", url: "frontier-audio://t", durationMs: takeMs } } : {},
    } as unknown as CellData
  }

  it("are left out without a stand-in, as before", () => {
    expect(buildProgramme([untimed("a"), untimed("b")]).slots).toHaveLength(0)
  })

  it("take a stand-in length when given one, and a recording's length once recorded", () => {
    const prog = buildProgramme([untimed("a"), untimed("b", 3_000)], { standInLenSec: () => 2 })
    expect(prog.slots.map((s) => [s.cellId, s.startSec, s.slotLenSec, s.standIn ?? false])).toEqual([
      ["a", 0, 2, true],
      ["b", 2, 3, false],
    ])
    // A stand-in has nothing to play, and no source window to invent.
    expect(prog.slots[0].clock).toBeNull()
    expect(prog.slots[0].sourceWindow).toBeNull()
    expect(prog.slots[1].clock).toBe("target")
    expect(prog.totalSec).toBe(5)
  })

  it("a timed file never gets stand-ins", () => {
    const prog = buildProgramme([verse("v1", 0, 3, { durationMs: 2_000 })], { standInLenSec: () => 9 })
    expect(prog.slots[0].standIn).toBeUndefined()
  })
})

describe("programmeLines: the one list the timeline and the transport share (AQU-2204)", () => {
  it("is the timed media cells when there are any", () => {
    const cells = [verse("v2", 5, 9), verse("v1", 0, 5), { ...verse("t", 1, 2), medium: "text" } as CellData]
    expect(programmeLines(cells)).toEqual({ lines: [cells[1], cells[0]], untimed: false })
  })

  it("is every line in order when nothing is timed", () => {
    const a = { id: "a", fileId: "f1", medium: "text", original: "a" } as unknown as CellData
    const b = { id: "b", fileId: "f1", medium: "text", original: "b" } as unknown as CellData
    expect(programmeLines([a, b])).toEqual({ lines: [a, b], untimed: true })
  })

  it("is empty, and not untimed, for an empty file", () => {
    expect(programmeLines([])).toEqual({ lines: [], untimed: false })
  })
})

// AQU-2204 (Sam, Oct 26): a pause someone left before a take stays inside its
// line when the file follows its recordings.
describe("buildProgramme — a pause before the take (AQU-2204)", () => {
  const placed = (offsetMs: number) => ({ durationMs: 3_000, targetOffsetMs: offsetMs }) as never

  it("keeps the pause inside the line: the take starts after it and the line is that much longer", () => {
    // Original 0-2 (2 s); take 3 s placed 0.8 s after the line's start.
    const prog = buildProgramme([verse("v1", 0, 2, placed(800)), verse("v2", 2, 4, { durationMs: 1_000 })])
    const [s1, s2] = prog.slots
    expect(s1.targetLeadSec).toBeCloseTo(0.8, 5)
    expect(s1.slotLenSec).toBeCloseTo(3.8, 5)
    expect(s1.clock).toBe("target")
    expect(s2.startSec).toBeCloseTo(3.8, 5)
  })

  it("a take that starts on its line, or before it, has no pause", () => {
    const prog = buildProgramme([verse("v1", 0, 2, placed(0)), verse("v2", 2, 4, placed(-300))])
    expect(prog.slots[0].targetLeadSec).toBeUndefined()
    expect(prog.slots[1].targetLeadSec).toBeUndefined()
    expect(prog.slots[0].slotLenSec).toBeCloseTo(3, 5)
  })
})
