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

  // Round 5: the master element plays the SOURCE clip even when a take is
  // selected (the take moved to the target overlay) — so the window applies
  // whenever the source clip attachment is still there.
  it("take selected but source clip present → still windowed (round 5)", () => {
    expect(
      trimWindowForCell(baseCell({
        id: "c1",
        medium: "media", startTime: 2.9, endTime: 5,
        selectedAudioId: "audio-c1-1700000000-abcdefgh.webm",
        attachments: {
          "audio-c1-1700000000-abcdefgh.webm": { url: "frontier-audio://take", type: "audio" },
          "audio-f1-1690000000-source12.mp3": { url: "frontier-audio://src", type: "audio" },
        },
      })),
    ).toEqual({ start: 2.9, end: 5 })
  })
})
