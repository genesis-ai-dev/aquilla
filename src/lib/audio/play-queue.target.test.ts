// Round 5 (AQU-646): the dub-overlay planner. The master element owns the
// clock (source clip, windowed); planTargetOverlay decides what the second
// element does when the master lands on a cell — fire that cell's dub, keep
// an overhanging clip ringing, or fall silent.

import { describe, expect, it } from "vitest"
import { planTargetOverlay } from "./play-queue"
import type { CellData } from "@/hooks/useCells"

const CLIP = "frontier-audio://clip-1.mp3"
const SOURCE_ID = "audio-f1-1690000000-shared.mp3"

let nextId = 0
const base = () =>
  ({
    fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "text", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    medium: "media" as const,
  })

/** Plain source section — no dub. */
const sourceCell = (startTime: number, endTime: number): CellData =>
  ({
    ...base(), id: `c${++nextId}`, startTime, endTime,
    selectedAudioId: SOURCE_ID,
    attachments: { [SOURCE_ID]: { type: "audio", url: CLIP } },
  }) as CellData

/** Dubbed section: take selected, source clip still attached. */
const dubbedCell = (startTime: number, endTime: number): CellData => {
  const id = `c${++nextId}`
  const takeId = `audio-${id}-1700000000-take.webm`
  return {
    ...base(), id, startTime, endTime,
    selectedAudioId: takeId,
    attachments: {
      [takeId]: { type: "audio", url: `frontier-audio://take-${id}.webm` },
      [SOURCE_ID]: { type: "audio", url: CLIP },
    },
  } as CellData
}

/** Section with a generated voice (source clip selected in the recording slot). */
const generatedCell = (startTime: number, endTime: number): CellData => {
  const id = `c${++nextId}`
  const genId = `audio-${id}-1700000001-gen.wav`
  return {
    ...base(), id, startTime, endTime,
    selectedAudioId: SOURCE_ID,
    selectedGeneratedVoiceAudioId: genId,
    attachments: {
      [SOURCE_ID]: { type: "audio", url: CLIP },
      [genId]: { type: "audio", url: `frontier-audio://gen-${id}.wav` },
    },
  } as CellData
}

/** Take-only section — the source clip is gone; the MASTER plays the take. */
const takeOnlyCell = (startTime: number, endTime: number): CellData => {
  const id = `c${++nextId}`
  const takeId = `audio-${id}-1700000000-take.webm`
  return {
    ...base(), id, startTime, endTime,
    selectedAudioId: takeId,
    attachments: { [takeId]: { type: "audio", url: `frontier-audio://take-${id}.webm` } },
  } as CellData
}

describe("planTargetOverlay", () => {
  it("fires a dubbed section's take on advance, from the top", () => {
    const cells = [sourceCell(0, 10), dubbedCell(10, 20)]
    const plan = planTargetOverlay(cells, 1, null, "advance", 10)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.cellId).toBe(cells[1].id)
    expect(plan.kind === "fire" && plan.audioId).toBe(cells[1].selectedAudioId)
    expect(plan.kind === "fire" && plan.startAtSec).toBe(0)
  })

  it("fires a section's generated voice when no take is selected", () => {
    const cells = [generatedCell(0, 10)]
    const plan = planTargetOverlay(cells, 0, null, "advance", 0)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.audioId).toBe(cells[0].selectedGeneratedVoiceAudioId)
  })

  it("a dub-less section on ADVANCE keeps an overhanging clip ringing", () => {
    const cells = [dubbedCell(0, 10), sourceCell(10, 20)]
    expect(planTargetOverlay(cells, 1, cells[0].id, "advance", 10)).toEqual({ kind: "keep" })
  })

  it("a dub-less section on SEEK cuts to silence", () => {
    const cells = [dubbedCell(0, 10), sourceCell(10, 20)]
    expect(planTargetOverlay(cells, 1, cells[0].id, "seek", 15)).toEqual({ kind: "silence" })
  })

  it("advancing within the already-firing cell keeps it (no restart)", () => {
    const cells = [dubbedCell(0, 10)]
    expect(planTargetOverlay(cells, 0, cells[0].id, "advance", 3)).toEqual({ kind: "keep" })
  })

  it("seeking into the already-firing cell re-joins it at the offset", () => {
    const cells = [dubbedCell(0, 10)]
    const plan = planTargetOverlay(cells, 0, cells[0].id, "seek", 4)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.startAtSec).toBe(4)
  })

  it("a newly-due dub fires even while a previous one rings (the fire cuts it)", () => {
    const cells = [dubbedCell(0, 10), dubbedCell(10, 20)]
    const plan = planTargetOverlay(cells, 1, cells[0].id, "advance", 10)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.cellId).toBe(cells[1].id)
  })

  it("take-ONLY section never fires the overlay — the master plays the take (double-fire guard)", () => {
    const cells = [takeOnlyCell(0, 10)]
    expect(planTargetOverlay(cells, 0, null, "advance", 0)).toEqual({ kind: "keep" })
    expect(planTargetOverlay(cells, 0, null, "seek", 5)).toEqual({ kind: "silence" })
  })

  it("out-of-range index → keep on advance, silence on seek", () => {
    const cells = [sourceCell(0, 10)]
    expect(planTargetOverlay(cells, 5, null, "advance", 0)).toEqual({ kind: "keep" })
    expect(planTargetOverlay(cells, 5, null, "seek", 0)).toEqual({ kind: "silence" })
  })
})

// ── Round 6: moved chips (target_start_ms) — arm ahead, join mid, skip past ──

const movedDubCell = (startTime: number, endTime: number, chipStartMs: number, durationMs?: number): CellData => {
  const base = dubbedCell(startTime, endTime)
  const takeId = base.selectedAudioId as string
  return {
    ...base,
    metadata: { target_start_ms: chipStartMs },
    attachments: {
      ...(base.attachments ?? {}),
      [takeId]: { ...(base.attachments?.[takeId] ?? {}), ...(durationMs != null ? { durationMs } : {}) },
    },
  } as CellData
}

describe("planTargetOverlay — offset-aware (round 6)", () => {
  it("clock BEFORE the chip's start → arm (keep on advance, silence on seek)", () => {
    const cells = [movedDubCell(10, 20, 14000)]
    expect(planTargetOverlay(cells, 0, null, "advance", 10)).toEqual({
      kind: "arm", cellId: cells[0].id, dueSec: 14, overlay: "keep",
    })
    expect(planTargetOverlay(cells, 0, null, "seek", 11)).toEqual({
      kind: "arm", cellId: cells[0].id, dueSec: 14, overlay: "silence",
    })
  })

  it("clock AT the chip's start → fire from the top", () => {
    const cells = [movedDubCell(10, 20, 14000)]
    const plan = planTargetOverlay(cells, 0, null, "advance", 14)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.startAtSec).toBe(0)
  })

  it("seek landing INSIDE the chip → join mid-clip", () => {
    const cells = [movedDubCell(10, 20, 14000, 5000)]
    const plan = planTargetOverlay(cells, 0, null, "seek", 16.5)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.startAtSec).toBeCloseTo(2.5)
  })

  it("clock past the chip's audible END → nothing new sounds (keep/silence)", () => {
    const cells = [movedDubCell(10, 20, 12000, 3000)] // chip [12, 15]
    expect(planTargetOverlay(cells, 0, null, "advance", 16)).toEqual({ kind: "keep" })
    expect(planTargetOverlay(cells, 0, null, "seek", 16)).toEqual({ kind: "silence" })
  })

  it("unknown duration never suppresses a past-due fire (length can't be judged)", () => {
    const cells = [movedDubCell(10, 20, 12000)] // no durationMs
    const plan = planTargetOverlay(cells, 0, null, "seek", 19)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.startAtSec).toBe(7)
  })
})
