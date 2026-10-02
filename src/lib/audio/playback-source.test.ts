import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

import {
  __resetPlaybackSourceForTests,
  defaultPlaybackSource,
  playbackSourceKey,
  readPlaybackSource,
  recordingDrivesPlayback,
  setPlaybackSource,
  usePlaybackSource,
} from "./playback-source"

// AQU-1565 follow-up. WHY: after uploading the original recording to a file
// linked to a YouTube video, the picture went silent and followed the upload.
// Sam: keep the video's own sound and picture as the default, and play the
// recording only when the person picks it. These pin that default, that the
// pick sticks per file, and that the client's streamed films keep the
// arrangement they always had (the recording drives).

const YT = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
const FILM = "https://cdn.thechosen.media/ep1/master.m3u8"

afterEach(() => {
  localStorage.clear()
  __resetPlaybackSourceForTests()
  vi.restoreAllMocks()
})

describe("defaultPlaybackSource", () => {
  it("is the video's own sound for a YouTube picture", () => {
    expect(defaultPlaybackSource(YT)).toBe("video")
    expect(defaultPlaybackSource("https://youtu.be/aqz-KE-bpKQ")).toBe("video")
  })

  it("is the recording for any other picture, and for none", () => {
    expect(defaultPlaybackSource(FILM)).toBe("recording")
    expect(defaultPlaybackSource("frontier-audio://clip.mp4")).toBe("recording")
    expect(defaultPlaybackSource(null)).toBe("recording")
  })
})

describe("the stored choice", () => {
  it("is remembered per file, and other files keep their default", () => {
    setPlaybackSource("f1", "recording")
    expect(localStorage.getItem(playbackSourceKey("f1"))).toBe("recording")
    expect(readPlaybackSource("f1", YT)).toBe("recording")
    expect(readPlaybackSource("f2", YT)).toBe("video")
  })

  it("survives a reload (read back from storage alone)", () => {
    localStorage.setItem(playbackSourceKey("f1"), "recording")
    expect(readPlaybackSource("f1", YT)).toBe("recording")
  })

  it("ignores a stored value it does not recognise", () => {
    localStorage.setItem(playbackSourceKey("f1"), "both")
    expect(readPlaybackSource("f1", YT)).toBe("video")
  })

  it("falls back to the default when storage cannot be read, and a pick still holds", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(readPlaybackSource("f1", YT)).toBe("video")
    setPlaybackSource("f1", "recording")
    expect(readPlaybackSource("f1", YT)).toBe("recording")
  })
})

describe("usePlaybackSource", () => {
  it("re-renders every reader when the person picks a sound", () => {
    const a = renderHook(() => usePlaybackSource("f1", YT))
    const b = renderHook(() => usePlaybackSource("f1", YT))
    expect(a.result.current).toBe("video")
    act(() => setPlaybackSource("f1", "recording"))
    expect(a.result.current).toBe("recording")
    expect(b.result.current).toBe("recording")
  })
})

describe("recordingDrivesPlayback", () => {
  it("needs both a recording on the rows and the recording chosen", () => {
    expect(recordingDrivesPlayback(true, "recording")).toBe(true)
    expect(recordingDrivesPlayback(true, "video")).toBe(false)
    expect(recordingDrivesPlayback(false, "recording")).toBe(false)
    expect(recordingDrivesPlayback(false, "video")).toBe(false)
  })
})
