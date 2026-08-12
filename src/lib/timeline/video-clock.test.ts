// The video clock's INVARIANTS. (AQU-646)
//
// This store is read by four surfaces that cannot see each other — the timeline
// playhead, the bottom bar, the dialogue table's marked row, and the dub
// driver's tick. Its whole value is that they all get one answer, so the rules
// about what a cleared clock implies are the point of the module, not detail.

import { describe, it, expect, beforeEach } from "vitest"
import {
  getVideoBuffering,
  getVideoClockPlaying,
  getVideoClockSec,
  getVideoSoundingCellId,
  resetVideoClockForTests,
  setVideoBuffering,
  setVideoClockPlaying,
  setVideoClockSec,
  setVideoSoundingCellId,
} from "./video-clock"

beforeEach(() => {
  resetVideoClockForTests()
})

describe("a cleared clock", () => {
  it("cannot be playing, on a line, or waiting to start", () => {
    // The pane pushes null to hand the transport back (a take arrives and the
    // queue takes over) or on unmount. Anything left set would go on driving a
    // playhead nobody is updating, mark a row on a file that is not playing,
    // or spin the bar's button forever.
    setVideoClockSec(12)
    setVideoClockPlaying(true)
    setVideoSoundingCellId("cue-3")
    setVideoBuffering(true)

    setVideoClockSec(null)

    expect(getVideoClockSec()).toBeNull()
    expect(getVideoClockPlaying()).toBe(false)
    expect(getVideoSoundingCellId()).toBeNull()
    expect(getVideoBuffering()).toBe(false)
  })

  it("treats a non-finite second as cleared", () => {
    setVideoClockSec(12)
    setVideoClockSec(NaN)
    expect(getVideoClockSec()).toBeNull()
  })
})

describe("an ordinary tick", () => {
  it("leaves playing, the line and the wait exactly as they were", () => {
    // `timeupdate` fires ~4Hz. If it could disturb any of these, every one of
    // them would flicker several times a second.
    setVideoClockSec(12)
    setVideoClockPlaying(true)
    setVideoSoundingCellId("cue-3")
    setVideoBuffering(true)

    setVideoClockSec(12.25)

    expect(getVideoClockPlaying()).toBe(true)
    expect(getVideoSoundingCellId()).toBe("cue-3")
    expect(getVideoBuffering()).toBe(true)
  })

  it("floors a negative position at zero", () => {
    setVideoClockSec(-4)
    expect(getVideoClockSec()).toBe(0)
  })
})

describe("buffering", () => {
  it("is off until something asks the picture to start", () => {
    expect(getVideoBuffering()).toBe(false)
  })

  it("is set and cleared independently of the position", () => {
    setVideoClockSec(12)
    setVideoBuffering(true)
    expect(getVideoBuffering()).toBe(true)
    expect(getVideoClockSec()).toBe(12)
    setVideoBuffering(false)
    expect(getVideoBuffering()).toBe(false)
    expect(getVideoClockSec()).toBe(12)
  })
})
