// Media redesign, layout: which arrangement a file starts from, by its kind.

import { describe, expect, it } from "vitest"
import { mediaFileKind, startingLayout } from "./media-layout-start"

const kind = (over: Partial<Parameters<typeof mediaFileKind>[0]>) =>
  mediaFileKind({ hasVideo: false, isSubtitleFile: false, hasAudioCues: false, isScripture: false, ...over })

describe("mediaFileKind", () => {
  it("reads a film dubbed against audio cues as a dubbing file", () => {
    expect(kind({ hasVideo: true, hasAudioCues: true })).toBe("dub")
    // Even when its lines came from a subtitle import.
    expect(kind({ hasVideo: true, hasAudioCues: true, isSubtitleFile: true })).toBe("dub")
  })

  it("reads a film with subtitles as a subtitles file", () => {
    expect(kind({ hasVideo: true, isSubtitleFile: true })).toBe("subtitles")
  })

  it("reads a scripture book with no film as scripture", () => {
    expect(kind({ isScripture: true })).toBe("scripture")
    expect(kind({ isScripture: true, hasVideo: true })).toBe("plain")
  })

  it("leaves everything else on today's layout", () => {
    expect(kind({})).toBe("plain")
    expect(kind({ hasAudioCues: true })).toBe("plain")
  })
})

describe("startingLayout", () => {
  // AQU-2343 (Sam, Nov 2): a file whose film shows starts with the timeline at
  // 45% of the media view and the film at 38% of the row below, whatever its kind.
  const film = { timelineHeight: "45%", videoWidth: "38%" }

  it("opens a dubbing file and a subtitles file with the film arrangement", () => {
    expect(startingLayout("dub")).toEqual(film)
    expect(startingLayout("subtitles")).toEqual(film)
  })

  it("opens any other file with a film the same way", () => {
    expect(startingLayout("plain", true)).toEqual(film)
    expect(startingLayout("scripture", true)).toEqual(film)
  })

  it("keeps a dubbing or subtitles file whose film is hidden (Follows recordings) on pixel sizes", () => {
    expect(startingLayout("subtitles", false)).toEqual({ timelineHeight: 304, videoWidth: 288 })
  })

  it("gives a scripture book's timeline the room", () => {
    expect(startingLayout("scripture").timelineHeight).toBe(460)
  })

  it("keeps today's sizes for every other file", () => {
    expect(startingLayout("plain")).toEqual({ timelineHeight: 304, videoWidth: 288 })
  })
})
