// Rounds 5-7 (AQU-646): the dub-overlay planner. The master element owns the
// clock (source clip, windowed); planTargetOverlay decides what the overlay
// POOL does when the master lands on a cell — fire that cell's dub (ADDITIVE
// on advance: an overhanging previous dub keeps ringing, "both sound";
// EXCLUSIVE on seek), keep, arm ahead of a moved chip, or fall silent.

import { describe, expect, it } from "vitest"
import { overlayKey, planEarlyDub, planTargetOverlay } from "./play-queue"
import { RECORDING_SLOT, slotAudible } from "@/lib/timeline/track-slots"
import type { CellData } from "@/hooks/useCells"

const NONE: ReadonlySet<string> = new Set()
/**
 * The "already sounding" set.
 *
 * AQU-646 stage 3: the pool is keyed by (cell, SLOT), because two takes on one
 * line — on different tracks — are the point of multi-track and must both
 * sound. These cases are all about the DEFAULT track, so they name its slot.
 */
const sounding = (...ids: string[]): ReadonlySet<string> =>
  new Set(ids.map((id) => overlayKey(id, RECORDING_SLOT)))

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
  it("fires a dubbed section's take on advance, from the top, ADDITIVELY", () => {
    const cells = [sourceCell(0, 10), dubbedCell(10, 20)]
    const plan = planTargetOverlay(cells, 1, NONE, "advance", 10)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.cellId).toBe(cells[1].id)
    expect(plan.kind === "fire" && plan.audioId).toBe(cells[1].selectedAudioId)
    expect(plan.kind === "fire" && plan.startAtClipSec).toBe(0)
    expect(plan.kind === "fire" && plan.exclusive).toBe(false)
  })

  it("fires a section's generated voice when no take is selected", () => {
    const cells = [generatedCell(0, 10)]
    const plan = planTargetOverlay(cells, 0, NONE, "advance", 0)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.audioId).toBe(cells[0].selectedGeneratedVoiceAudioId)
  })

  it("a dub-less section on ADVANCE keeps an overhanging clip ringing", () => {
    const cells = [dubbedCell(0, 10), sourceCell(10, 20)]
    expect(planTargetOverlay(cells, 1, sounding(cells[0].id), "advance", 10)).toEqual({ kind: "keep" })
  })

  it("a dub-less section on SEEK cuts to silence", () => {
    const cells = [dubbedCell(0, 10), sourceCell(10, 20)]
    expect(planTargetOverlay(cells, 1, sounding(cells[0].id), "seek", 15)).toEqual({ kind: "silence" })
  })

  it("advancing within an already-sounding cell keeps it (no restart)", () => {
    const cells = [dubbedCell(0, 10)]
    expect(planTargetOverlay(cells, 0, sounding(cells[0].id), "advance", 3)).toEqual({ kind: "keep" })
  })

  it("seeking into an already-sounding cell re-joins it at the offset, exclusively", () => {
    const cells = [dubbedCell(0, 10)]
    const plan = planTargetOverlay(cells, 0, sounding(cells[0].id), "seek", 4)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.startAtClipSec).toBe(4)
    expect(plan.kind === "fire" && plan.exclusive).toBe(true)
  })

  it("ROUND 7: a newly-due dub fires WHILE a previous one rings — both sound (non-exclusive)", () => {
    const cells = [dubbedCell(0, 10), dubbedCell(10, 20)]
    const plan = planTargetOverlay(cells, 1, sounding(cells[0].id), "advance", 10)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.cellId).toBe(cells[1].id)
    expect(plan.kind === "fire" && plan.exclusive).toBe(false)
  })

  it("take-ONLY section never fires the overlay — the master plays the take (double-fire guard)", () => {
    const cells = [takeOnlyCell(0, 10)]
    expect(planTargetOverlay(cells, 0, NONE, "advance", 0)).toEqual({ kind: "keep" })
    expect(planTargetOverlay(cells, 0, NONE, "seek", 5)).toEqual({ kind: "silence" })
  })

  it("out-of-range index → keep on advance, silence on seek", () => {
    const cells = [sourceCell(0, 10)]
    expect(planTargetOverlay(cells, 5, NONE, "advance", 0)).toEqual({ kind: "keep" })
    expect(planTargetOverlay(cells, 5, NONE, "seek", 0)).toEqual({ kind: "silence" })
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
    expect(planTargetOverlay(cells, 0, NONE, "advance", 10)).toEqual({
      kind: "arm", cellId: cells[0].id, dueSec: 14, overlay: "keep",
    })
    expect(planTargetOverlay(cells, 0, NONE, "seek", 11)).toEqual({
      kind: "arm", cellId: cells[0].id, dueSec: 14, overlay: "silence",
    })
  })

  it("clock AT the chip's start → fire from the top", () => {
    const cells = [movedDubCell(10, 20, 14000)]
    const plan = planTargetOverlay(cells, 0, NONE, "advance", 14)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.startAtClipSec).toBe(0)
  })

  it("seek landing INSIDE the chip → join mid-clip, exclusive", () => {
    const cells = [movedDubCell(10, 20, 14000, 5000)]
    const plan = planTargetOverlay(cells, 0, NONE, "seek", 16.5)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.startAtClipSec).toBeCloseTo(2.5)
    expect(plan.kind === "fire" && plan.exclusive).toBe(true)
  })

  it("clock past the chip's audible END → nothing new sounds (keep/silence)", () => {
    const cells = [movedDubCell(10, 20, 12000, 3000)] // chip [12, 15]
    expect(planTargetOverlay(cells, 0, NONE, "advance", 16)).toEqual({ kind: "keep" })
    expect(planTargetOverlay(cells, 0, NONE, "seek", 16)).toEqual({ kind: "silence" })
  })

  it("unknown duration never suppresses a past-due fire (length can't be judged)", () => {
    const cells = [movedDubCell(10, 20, 12000)] // no durationMs
    const plan = planTargetOverlay(cells, 0, NONE, "seek", 19)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.startAtClipSec).toBe(7)
  })
})

// ── Round 7: TRIMMED chips — due/cue/stop are trim-aware ──

const trimmedDubCell = (
  startTime: number,
  endTime: number,
  anchorMs: number,
  durationMs: number,
  trims: { trimStartMs?: number; trimEndMs?: number },
): CellData => {
  const base = movedDubCell(startTime, endTime, anchorMs, durationMs)
  const takeId = base.selectedAudioId as string
  return {
    ...base,
    attachments: {
      ...(base.attachments ?? {}),
      [takeId]: { ...(base.attachments?.[takeId] ?? {}), ...trims },
    },
  } as CellData
}

describe("planTargetOverlay — trim-aware (round 7)", () => {
  it("a head-trimmed dub is due at its AUDIBLE start and cues at trimStart", () => {
    const cells = [trimmedDubCell(10, 20, 12000, 5000, { trimStartMs: 1000 })] // audible [13, 17]
    expect(planTargetOverlay(cells, 0, NONE, "advance", 12.5)).toMatchObject({ kind: "arm", dueSec: 13 })
    const plan = planTargetOverlay(cells, 0, NONE, "advance", 13)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.startAtClipSec).toBeCloseTo(1) // trimStart on the clip clock
  })

  it("a tail-trimmed dub carries its stop point and suppresses past it", () => {
    const cells = [trimmedDubCell(10, 20, 12000, 5000, { trimEndMs: 3000 })] // audible [12, 15]
    const plan = planTargetOverlay(cells, 0, NONE, "advance", 12)
    expect(plan.kind === "fire" && plan.stopAtClipSec).toBe(3)
    expect(planTargetOverlay(cells, 0, NONE, "seek", 15.5)).toEqual({ kind: "silence" })
  })

  it("a mid-dub seek on a head-trimmed chip joins at trimStart + progress", () => {
    const cells = [trimmedDubCell(10, 20, 12000, 5000, { trimStartMs: 1000 })] // audible starts 13
    const plan = planTargetOverlay(cells, 0, NONE, "seek", 14.5)
    expect(plan.kind).toBe("fire")
    expect(plan.kind === "fire" && plan.startAtClipSec).toBeCloseTo(2.5) // 1 + 1.5
  })
})

describe("planEarlyDub — a later section's backward-slid dub (end-based bounds)", () => {
  it("arms the NEXT section's dub when its chip starts inside the current window", () => {
    const cells = [sourceCell(0, 10), movedDubCell(10, 20, 8000, 6000)] // chip at 8, window ends 10
    const plan = planEarlyDub(cells, 0, NONE)
    expect(plan).toEqual({ cellId: cells[1].id, dueSec: 8 })
  })

  it("stays null when the next chip starts at or after the window end", () => {
    const cells = [sourceCell(0, 10), movedDubCell(10, 20, 10000, 6000)]
    expect(planEarlyDub(cells, 0, NONE)).toBeNull()
  })

  it("scans past dub-less sections to the first eligible cell", () => {
    const cells = [sourceCell(0, 10), sourceCell(10, 20), movedDubCell(20, 30, 7000, 6000)]
    const plan = planEarlyDub(cells, 0, NONE)
    expect(plan).toEqual({ cellId: cells[2].id, dueSec: 7 })
  })

  it("skips take-only sections (their dub rides the MASTER, not the pool)", () => {
    const cells = [sourceCell(0, 10), takeOnlyCell(10, 20), movedDubCell(20, 30, 6000, 6000)]
    const plan = planEarlyDub(cells, 0, NONE)
    expect(plan).toEqual({ cellId: cells[2].id, dueSec: 6 })
  })

  it("refuses a dub that is already sounding — never a re-fire restart", () => {
    const cells = [sourceCell(0, 10), movedDubCell(10, 20, 8000, 6000)]
    expect(planEarlyDub(cells, 0, sounding(cells[1].id))).toBeNull()
  })

  it("the due time is the AUDIBLE start — trim-aware", () => {
    const cells = [sourceCell(0, 10), trimmedDubCell(10, 20, 8000, 6000, { trimStartMs: 1000 })]
    const plan = planEarlyDub(cells, 0, NONE)
    expect(plan?.dueSec).toBe(9) // anchor 8 + head trim 1
  })

  it("the first eligible cell DECIDES: an in-place near dub blocks a farther slid-back one", () => {
    // c2's dub sits at its own section (12 ≥ window end 10) → null, even
    // though c3's chip reaches back to 5. Documented one-slot simplification.
    const cells = [sourceCell(0, 10), movedDubCell(10, 20, 12000, 4000), movedDubCell(20, 30, 5000, 20000)]
    expect(planEarlyDub(cells, 0, NONE)).toBeNull()
  })

  it("no current window (text cell) → null", () => {
    const bare = { ...sourceCell(0, 10) } as CellData & { startTime?: number; endTime?: number }
    delete bare.startTime
    delete bare.endTime
    expect(planEarlyDub([bare, movedDubCell(10, 20, 8000, 6000)], 0, NONE)).toBeNull()
  })
})

// ── AQU-646 stage 3: two tracks sounding on ONE line ───────────────────────
//
// This is the behaviour the whole slot change exists for, and it had three
// separate things silently preventing it. `planTargetOverlay` is one of them —
// its already-sounding guard was keyed by cell, so the second track's take was
// suppressed as a duplicate of the first.

describe("planTargetOverlay — per track", () => {
  const TRACK = "019fd21a-a5a4-75d1-b8c4-3b60072a4fc2"

  /** One line carrying a take on the default row AND on an added track. */
  const twoTrackCell = (startTime: number, endTime: number): CellData => {
    const id = `c${++nextId}`
    const takeId = `audio-${id}-1700000000-take.webm`
    const trackTakeId = `audio-${id}-1700000001-trk.webm`
    return {
      ...base(), id, startTime, endTime,
      selectedAudioId: takeId,
      selectedBySlot: { recording: takeId, [TRACK]: trackTakeId },
      attachments: {
        [takeId]: { type: "audio", url: CLIP, durationMs: 4000 },
        [trackTakeId]: { type: "audio", url: "frontier-audio://trk.webm", durationMs: 4000 },
        [SOURCE_ID]: { type: "audio", url: CLIP },
      },
    } as CellData
  }

  it("fires each track's OWN take from the same line", () => {
    const cells = [twoTrackCell(0, 10)]
    const a = planTargetOverlay(cells, 0, NONE, "advance", 0)
    const b = planTargetOverlay(cells, 0, NONE, "advance", 0, { slot: TRACK })
    expect(a.kind).toBe("fire")
    expect(b.kind).toBe("fire")
    expect(a.kind === "fire" && b.kind === "fire" && a.audioId).not.toBe(
      b.kind === "fire" ? b.audioId : null,
    )
    expect(b.kind === "fire" && b.slot).toBe(TRACK)
  })

  // THE SUPPRESSION THIS FIXES. The default row's take already ringing must not
  // read as "this line is covered" for the other track.
  it("does not let one track's sounding take suppress another's", () => {
    const cells = [twoTrackCell(0, 10)]
    const already = sounding(cells[0].id) // the default row is ringing
    expect(planTargetOverlay(cells, 0, already, "advance", 0).kind).toBe("keep")
    expect(planTargetOverlay(cells, 0, already, "advance", 0, { slot: TRACK }).kind).toBe("fire")
  })

  it("…and still refuses to re-fire the SAME track's ringing take", () => {
    const cells = [twoTrackCell(0, 10)]
    const already = new Set([overlayKey(cells[0].id, TRACK)])
    expect(planTargetOverlay(cells, 0, already, "advance", 0, { slot: TRACK }).kind).toBe("keep")
  })

  // An added track's takes stand alone — there is no shared source clip in its
  // slot, so requiring one (the default row's rule) would silence every one.
  it("needs no source clip on an added track", () => {
    const id = `c${++nextId}`
    const trackTakeId = `audio-${id}-1700000002-trk.webm`
    const cells = [
      {
        ...base(), id, startTime: 0, endTime: 10,
        selectedBySlot: { [TRACK]: trackTakeId },
        attachments: { [trackTakeId]: { type: "audio", url: "frontier-audio://trk.webm", durationMs: 4000 } },
      } as CellData,
    ]
    expect(planTargetOverlay(cells, 0, NONE, "advance", 0, { slot: TRACK }).kind).toBe("fire")
    // …while the default row, with no take of its own, has nothing to sound.
    expect(planTargetOverlay(cells, 0, NONE, "advance", 0).kind).toBe("keep")
  })
})

describe("slotAudible — one mute per track", () => {
  const TRACK = "019fd21a-a5a4-75d1-b8c4-3b60072a4fc2"

  it("answers the default row from `target`, as it always has", () => {
    expect(slotAudible({ target: true }, RECORDING_SLOT)).toBe(true)
    expect(slotAudible({ target: false }, RECORDING_SLOT)).toBe(false)
    // …and a generated voice is the same track, so the same flag.
    expect(slotAudible({ target: false }, "generatedVoice")).toBe(false)
  })

  // ABSENT MEANS AUDIBLE. A brand-new track is heard without anybody opting in,
  // and the flag can only be there because someone switched it off.
  it("treats an added track with no flag as audible", () => {
    expect(slotAudible({ target: true }, TRACK)).toBe(true)
    expect(slotAudible({ target: true, bySlot: {} }, TRACK)).toBe(true)
  })

  it("silences exactly the track that was muted", () => {
    const state = { target: true, bySlot: { [TRACK]: false } }
    expect(slotAudible(state, TRACK)).toBe(false)
    expect(slotAudible(state, RECORDING_SLOT)).toBe(true)
  })

  it("…and muting the default row leaves an added track sounding", () => {
    const state = { target: false, bySlot: { [TRACK]: true } }
    expect(slotAudible(state, RECORDING_SLOT)).toBe(false)
    expect(slotAudible(state, TRACK)).toBe(true)
  })
})
