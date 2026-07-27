// AQU-646 SUB-53 — the audio-first layout. Every verse takes as much room as
// its longer side, laid end to end, and the two sides share a left edge.

import { describe, expect, it } from "vitest"
import {
  buildProgramme,
  cellStartProgrammeSec,
  programmeToSource,
  programmeToTarget,
  slotAtProgrammeSec,
  slotForCell,
  sourceFileSecToProgramme,
  targetRatio,
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

  it("the ORIGINAL wins the slot when it is the longer side", () => {
    const prog = buildProgramme([verse("v1", 0, 9, { durationMs: 4_000 })])
    expect(prog.slots[0]).toMatchObject({ sourceLenSec: 9, targetLenSec: 4, slotLenSec: 9, clock: "source" })
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
    expect(trimmed.totalSec).toBe(9)
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
    verse("v2", 6, 16, { durationMs: 4_000 }), // slot 11→21: original 10s, translation 4s
  ])

  it("finds the verse a programme second falls in", () => {
    expect(slotAtProgrammeSec(prog, 0)?.cellId).toBe("v1")
    expect(slotAtProgrammeSec(prog, 10.9)?.cellId).toBe("v1")
    expect(slotAtProgrammeSec(prog, 11)?.cellId).toBe("v2")
    expect(slotAtProgrammeSec(prog, 20.9)?.cellId).toBe("v2")
  })

  it("past the end, or before the start, is nothing", () => {
    expect(slotAtProgrammeSec(prog, 21)).toBeNull()
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
    // v2 is the other way round: the translation runs out first.
    expect(programmeToTarget(prog, 11 + 3.9)?.clipSec).toBeCloseTo(3.9, 6)
    expect(programmeToTarget(prog, 11 + 4)).toBeNull()
    expect(programmeToSource(prog, 11 + 9.9)?.clipSec).toBeCloseTo(15.9, 6)
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
    expect(sourceFileSecToProgramme(prog, 15)).toBe(20)
    expect(sourceFileSecToProgramme(prog, 99)).toBeNull()
  })

  it("round-trips a source position through both directions", () => {
    for (const fileSec of [0, 3.25, 6, 12, 15.75]) {
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
