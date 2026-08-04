import { describe, expect, it } from "vitest"
import { trimWindowForCell } from "./play-queue"
import type { CellData } from "@/hooks/useCells"

const baseCell = (over: Partial<CellData>): CellData =>
  ({
    id: "c1", fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "text", status: "empty", validationStatus: "unvalidated",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    ...over,
  }) as CellData

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

// SUB-29: a take recorded onto a media cell is its OWN clip — no film-timeline
// window. The window only applies when the imported source clip is selected.
describe("trimWindowForCell — attachment provenance (SUB-29)", () => {
  it("source clip selected (fileId-seeded audioId) → windowed", () => {
    expect(
      trimWindowForCell(baseCell({
        medium: "media", startTime: 2.9, endTime: 5,
        selectedAudioId: "audio-file-9-1700000000-abcdefgh.mp3",
      })),
    ).toEqual({ start: 2.9, end: 5 })
  })

  it("take selected (cellId-seeded audioId) → plays in full (null window)", () => {
    expect(
      trimWindowForCell(baseCell({
        id: "c1",
        medium: "media", startTime: 2.9, endTime: 5,
        selectedAudioId: "audio-c1-1700000000-abcdefgh.webm",
      })),
    ).toBeNull()
  })
})

// AQU-784: the selected attachment's persisted trim window (ms) is the
// authoritative in-clip slice — the same coordinate the timeline card and
// transcription address. It wins over the cell's timeline placement, which a
// `cell.retime` drag (or a trim-on-attachment-only import) moves independently.
describe("trimWindowForCell — attachment trim is the source of truth (AQU-784)", () => {
  it("prefers the attachment trim over a diverged cell placement", () => {
    expect(
      trimWindowForCell(baseCell({
        medium: "media",
        startTime: 0, endTime: 0, // stale/wrong placement after a retime
        selectedAudioId: "audio-file-9-1700000000-abcdefgh.mp3",
        attachments: { "audio-file-9-1700000000-abcdefgh.mp3": { type: "audio", url: "u", trimStartMs: 10_000, trimEndMs: 22_000 } },
      })),
    ).toEqual({ start: 10, end: 22 })
  })

  it("times the section from the attachment even when the cell carries no placement", () => {
    expect(
      trimWindowForCell(baseCell({
        medium: "media",
        selectedAudioId: "audio-file-9-1700000000-abcdefgh.mp3",
        attachments: { "audio-file-9-1700000000-abcdefgh.mp3": { type: "audio", url: "u", trimStartMs: 3_000, trimEndMs: 5_500 } },
      })),
    ).toEqual({ start: 3, end: 5.5 })
  })

  it("falls back to the cell placement when the attachment has no usable trim", () => {
    expect(
      trimWindowForCell(baseCell({
        medium: "media", startTime: 2.9, endTime: 5,
        selectedAudioId: "audio-file-9-1700000000-abcdefgh.mp3",
        attachments: { "audio-file-9-1700000000-abcdefgh.mp3": { type: "audio", url: "u" } },
      })),
    ).toEqual({ start: 2.9, end: 5 })
    // A degenerate attachment trim is ignored, not trapped at the placement.
    expect(
      trimWindowForCell(baseCell({
        medium: "media", startTime: 2.9, endTime: 5,
        selectedAudioId: "audio-file-9-1700000000-abcdefgh.mp3",
        attachments: { "audio-file-9-1700000000-abcdefgh.mp3": { type: "audio", url: "u", trimStartMs: 5_000, trimEndMs: 5_000 } },
      })),
    ).toEqual({ start: 2.9, end: 5 })
  })

  it("still plays a take in full even if its attachment carries a trim", () => {
    // Take selected (cellId-seeded) short-circuits before the attachment read.
    expect(
      trimWindowForCell(baseCell({
        id: "c1", medium: "media", startTime: 2.9, endTime: 5,
        selectedAudioId: "audio-c1-1700000000-abcdefgh.webm",
        attachments: { "audio-c1-1700000000-abcdefgh.webm": { type: "audio", url: "u", trimStartMs: 1_000, trimEndMs: 2_000 } },
      })),
    ).toBeNull()
  })
})
