import { describe, expect, it } from "vitest"
import { cellPlaybackWindow } from "./cell-playback-window"
import type { CellData } from "@/hooks/useCells"

const baseCell = (over: Partial<CellData>): CellData =>
  ({
    id: "c1", fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "text", status: "empty", validationStatus: "unvalidated",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    ...over,
  }) as CellData

const NO_CROP = { start: null, end: null }

// WHY (AQU-647): the audio tab's per-cell player (useCellAudio) is what plays a
// section — NOT the global play-queue. Imported MP3 sections share ONE clip,
// windowed per cell by [startTime,endTime). Before the fix the panel fed only
// the manual crop pref (null on a fresh import) into the player, so clicking any
// section streamed the shared clip from 0:00 — every section sounded like the
// file's opening "Greetings…". The section window must constrain playback.
describe("cellPlaybackWindow", () => {
  it("uses the media-segment window for an imported section (no crop)", () => {
    // Regression guard: a mid-file section must play its own range, not 0:00.
    expect(
      cellPlaybackWindow(baseCell({ medium: "media", startTime: 12, endTime: 20 }), NO_CROP),
    ).toEqual({ start: 12, end: 20 })
  })

  it("plays the first section from the start (no off-by-one)", () => {
    expect(
      cellPlaybackWindow(baseCell({ medium: "media", startTime: 0, endTime: 8 }), NO_CROP),
    ).toEqual({ start: 0, end: 8 })
  })

  it("narrows a media section further with a manual crop, clamped within it", () => {
    // Crop inside the section → intersection.
    expect(
      cellPlaybackWindow(
        baseCell({ medium: "media", startTime: 10, endTime: 20 }),
        { start: 12, end: 18 },
      ),
    ).toEqual({ start: 12, end: 18 })
    // A stale/oversized crop can never widen playback past the section boundary.
    expect(
      cellPlaybackWindow(
        baseCell({ medium: "media", startTime: 10, endTime: 20 }),
        { start: 2, end: 99 },
      ),
    ).toEqual({ start: 10, end: 20 })
  })

  it("leaves ordinary cells on the manual crop alone (no section window)", () => {
    // A per-cell recording: startTime/endTime are subtitle timings, not offsets
    // into the recording, so they must NOT constrain it.
    expect(
      cellPlaybackWindow(baseCell({ medium: "text", startTime: 120, endTime: 125 }), NO_CROP),
    ).toEqual({ start: null, end: null })
    expect(
      cellPlaybackWindow(baseCell({}), { start: 1.5, end: 3 }),
    ).toEqual({ start: 1.5, end: 3 })
  })

  it("ignores a degenerate media window and falls back to the crop", () => {
    expect(
      cellPlaybackWindow(baseCell({ medium: "media", startTime: 5, endTime: 5 }), { start: 1, end: 2 }),
    ).toEqual({ start: 1, end: 2 })
  })
})
