import { afterEach, describe, expect, it } from "vitest"
import { act, renderHook } from "@testing-library/react"

import type { CellData } from "@/hooks/useCells"
import {
  resetVideoClockForTests,
  setVideoBuffering,
  setVideoClockPlaying,
  setVideoClockSec,
  setVideoSoundingCellId,
} from "@/lib/timeline/video-clock"
import { resetVirtualClockForTests, startVirtualClock, virtualClockSeek } from "@/lib/timeline/virtual-clock"
import {
  useHeldCellIdOnClock,
  useTransportForFile,
  useTransportStateForFile,
  type UseTransportForFileArgs,
} from "./useTransportForFile"

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

// The workspace reads the seconds-free answer so the clocks' ticks do not
// re-render it. It must be the full answer, less the clock, in every state.
describe("useTransportStateForFile", () => {
  afterEach(() => {
    resetVideoClockForTests()
    resetVirtualClockForTests()
  })

  it("agrees with useTransportForFile, less the progress", () => {
    const filmless = { ...base, coreMediaUrl: null, anyCellClockIsFileTime: false }
    const cases: { name: string; args: UseTransportForFileArgs; arrange: () => void }[] = [
      { name: "idle", args: base, arrange: () => {} },
      { name: "film opening", args: { ...base, playbackSource: "video" }, arrange: () => setVideoBuffering(true) },
      {
        name: "film playing a line",
        args: { ...base, playbackSource: "video" },
        arrange: () => { setVideoClockSec(12); setVideoClockPlaying(true); setVideoSoundingCellId("c1") },
      },
      { name: "film paused in a gap", args: { ...base, playbackSource: "video" }, arrange: () => setVideoClockSec(3) },
      {
        name: "virtual clock",
        args: { ...filmless, virtualSoundingCellId: "c1" },
        arrange: () => { startVirtualClock(60); virtualClockSeek(4) },
      },
    ]
    const results = cases.map(({ name, args, arrange }) => {
      arrange()
      const full = renderHook(() => useTransportForFile(args)).result.current
      const state = renderHook(() => useTransportStateForFile(args)).result.current
      resetVideoClockForTests()
      resetVirtualClockForTests()
      const { progress: _progress, ...expected } = full
      return { name, state, expected }
    })
    expect(results.map((r) => `${r.state.source}:${r.state.kind}`)).toEqual([
      "queue:idle", "video:loading", "video:playing", "video:paused", "virtual:paused",
    ])
    for (const { name, state, expected } of results) expect({ name, ...state }).toEqual({ name, ...expected })
  })

  it("holds the last line through a silence, and re-renders only when the line changes", () => {
    const lines = [
      { id: "a", startTime: 0, endTime: 2 },
      { id: "b", startTime: 5, endTime: 7 },
    ] as CellData[]
    startVirtualClock(10)
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useHeldCellIdOnClock("virtual", true, lines)
    })
    expect(result.current).toBe("a")
    const before = renders
    act(() => virtualClockSeek(1))
    act(() => virtualClockSeek(3))
    expect(result.current).toBe("a")
    expect(renders).toBe(before)
    act(() => virtualClockSeek(5.5))
    expect(result.current).toBe("b")
  })
})
