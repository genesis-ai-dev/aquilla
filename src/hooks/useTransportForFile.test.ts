import { describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"

import { useTransportForFile, type UseTransportForFileArgs } from "./useTransportForFile"

// AQU-1565 follow-up. WHY: which engine owns a file decides what the playback
// bar drives. On a YouTube file with an uploaded recording the person's choice
// of sound now decides it: the video's own sound keeps the picture in charge,
// the recording hands it to the queue. And with the pane OFF screen there is
// no picture to drive, so the real recording must still play rather than a
// silent virtual playhead.

const YT = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
const base: UseTransportForFileArgs = {
  cellIds: new Set(["c1"]),
  coreMediaUrl: YT,
  anyCellClockIsFileTime: true,
  paneOnScreen: true,
  timelineDurationSec: 60,
}

const sourceOf = (args: UseTransportForFileArgs) =>
  renderHook(() => useTransportForFile(args)).result.current.source

describe("useTransportForFile with a chosen playback source", () => {
  it("leaves the picture in charge when the video's own sound is chosen", () => {
    expect(sourceOf({ ...base, playbackSource: "video" })).toBe("video")
  })

  it("hands the file to the queue when the recording is chosen", () => {
    expect(sourceOf({ ...base, playbackSource: "recording" })).toBe("queue")
  })

  it("keeps the old rule when no choice is passed (the recording drives)", () => {
    expect(sourceOf(base)).toBe("queue")
  })

  it("plays the recording, not a silent playhead, when the pane is off screen", () => {
    expect(sourceOf({ ...base, paneOnScreen: false, playbackSource: "video" })).toBe("queue")
  })

  it("is unchanged for a file with no recording: the picture drives", () => {
    expect(sourceOf({ ...base, anyCellClockIsFileTime: false, playbackSource: "recording" })).toBe("video")
  })
})
