import { describe, it, expect } from "vitest"
import { findFileClip } from "./run-diarization"
import type { CellData } from "@/hooks/useCells"

// WHY: diarization must locate the file's shared media clip (R2 object name +
// audioId) from a media cell's attachments to send to /start and re-attach per
// segment. A regression here means "no clip found" or diarizing the wrong audio.

const cell = (c: Partial<CellData>): CellData => ({ id: "c", fileId: "f", original: "", translated: "", context: "", group: "", type: "media", status: "empty", validationStatus: "none", activeValidators: [], validationHistory: [], history: [], threads: [], ...c }) as CellData

describe("findFileClip", () => {
  it("returns the clip object-name + audioId from a media cell's selected attachment", () => {
    const clip = findFileClip([
      cell({
        id: "m1",
        medium: "media",
        selectedAudioId: "audio-x",
        attachments: { "audio-x": { url: "frontier-audio://audio-x.webm", type: "audio" } },
      }),
    ])
    expect(clip).toEqual({ objectName: "audio-x.webm", audioId: "audio-x", url: "frontier-audio://audio-x.webm" })
  })

  it("falls back to the first attachment when selectedAudioId is unset", () => {
    const clip = findFileClip([
      cell({ medium: "media", attachments: { "a.mp3-id": { url: "frontier-audio://a.mp3", type: "audio" } } }),
    ])
    expect(clip?.objectName).toBe("a.mp3")
  })

  it("ignores text cells and returns null when no media clip exists", () => {
    expect(findFileClip([cell({ medium: "text" }), cell({ medium: "media" })])).toBeNull()
  })
})
