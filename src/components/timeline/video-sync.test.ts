import { describe, it, expect } from "vitest"
import {
  videoSyncAction,
  VIDEO_SEEK_COOLDOWN_MS,
  type VideoSyncInput,
} from "./video-sync"

// A healthy mid-playback sample: the queue has ticked once at t=1000 with the
// clock at 10s, and we are re-evaluating 250ms later (one tick interval).
function input(over: Partial<VideoSyncInput> = {}): VideoSyncInput {
  return {
    kind: "playing",
    clockIsFileTime: true,
    tickSec: 10.25,
    videoSec: 10.25,
    prevTickSec: 10,
    prevTickAt: 1000,
    now: 1250,
    rate: 1,
    duration: 420,
    lastSeekAt: null,
    ...over,
  }
}

describe("videoSyncAction", () => {
  it("holds position in terminal states — the queue zeroes its clock there", () => {
    // Reading the zeroed clock as a position would rewind the film the instant
    // playback finished.
    expect(videoSyncAction(input({ kind: "idle", tickSec: 0 }))).toEqual({ kind: "pause" })
    expect(videoSyncAction(input({ kind: "error", tickSec: 0 }))).toEqual({ kind: "pause" })
  })

  it("pauses when the queue's clock is a per-take clock, not file time", () => {
    expect(videoSyncAction(input({ clockIsFileTime: false }))).toEqual({ kind: "pause" })
  })

  it("pauses until the video reports a usable duration", () => {
    expect(videoSyncAction(input({ duration: Number.NaN }))).toEqual({ kind: "pause" })
    expect(videoSyncAction(input({ duration: 0 }))).toEqual({ kind: "pause" })
  })

  it("holds the last frame once the audio outruns the footage", () => {
    expect(videoSyncAction(input({ duration: 10, tickSec: 9.9 }))).toEqual({ kind: "pause" })
  })

  it("a playhead that jumps past the film's end puts the picture on its last frame (AQU-2253)", () => {
    // A book longer than its film: the playhead cut from 0:12 to 0:40 on a
    // 27-second film. Pausing where it was would leave the panel showing 0:12
    // while the strip under the playhead has ended. It goes to the end instead,
    // and stays there.
    expect(videoSyncAction(input({ duration: 27, tickSec: 40, prevTickSec: 12, videoSec: 12 }))).toEqual({
      kind: "end",
      sec: 26.75,
    })
    // Already on it: nothing more to do than stay paused.
    expect(videoSyncAction(input({ duration: 27, tickSec: 41, prevTickSec: 40, videoSec: 26.75 }))).toEqual({
      kind: "pause",
    })
  })

  it("does not chase a transient clock during a cross-clip resolve", () => {
    expect(videoSyncAction(input({ kind: "loading", tickSec: 300 }))).toEqual({ kind: "none" })
  })

  it("anchors on the first tick it sees", () => {
    expect(videoSyncAction(input({ prevTickSec: null, prevTickAt: null }))).toEqual({
      kind: "seek",
      sec: 10.25,
    })
  })

  it("leaves a freewheeling video alone through ordinary ticks", () => {
    expect(videoSyncAction(input())).toEqual({ kind: "none" })
  })

  it("tolerates a lagging tick at 2x — the regression this design exists for", () => {
    // The queue publishes on the audio element's ~250ms timeupdate, so at 2x its
    // time trails the true head by up to 0.5 media-seconds. Comparing that to a
    // live video.currentTime would seek on nearly every tick; comparing tick to
    // predicted tick cancels the lag.
    const stale = input({ rate: 2, prevTickSec: 10, prevTickAt: 1000, now: 1400, tickSec: 10.4 })
    expect(videoSyncAction(stale)).toEqual({ kind: "none" })
  })

  it("seeks on a backward jump", () => {
    expect(videoSyncAction(input({ tickSec: 5 }))).toEqual({ kind: "seek", sec: 5 })
  })

  it("seeks on a forward jump far past the prediction", () => {
    expect(videoSyncAction(input({ tickSec: 300 }))).toEqual({ kind: "seek", sec: 300 })
  })

  it("never seeks twice inside the cooldown", () => {
    const jump = input({ tickSec: 300 })
    expect(videoSyncAction({ ...jump, lastSeekAt: jump.now - 100 })).toEqual({ kind: "none" })
    expect(videoSyncAction({ ...jump, lastSeekAt: jump.now - VIDEO_SEEK_COOLDOWN_MS })).toEqual({
      kind: "seek",
      sec: 300,
    })
  })

  it("while paused, any clock movement is a scrub and repositions the picture", () => {
    const paused = input({ kind: "paused", prevTickSec: 10, tickSec: 10.2 })
    expect(videoSyncAction(paused)).toEqual({ kind: "seek", sec: 10.2 })
    // ...but a clock sitting still does not.
    expect(videoSyncAction({ ...paused, tickSec: 10 })).toEqual({ kind: "none" })
  })

  it("catches a video freewheeling away from the sound", () => {
    // Measured at 2x on the live stack: the queue's clock advanced ~1.76x while
    // the video ran a true 2x, so the picture pulled 2.4s ahead with the
    // tick-to-tick test seeing nothing wrong — every tick landed exactly where
    // the previous one predicted.
    const healthyTicks = { prevTickSec: 10, prevTickAt: 1000, now: 1250, tickSec: 10.5, rate: 2 }
    expect(videoSyncAction(input({ ...healthyTicks, videoSec: 10.5 }))).toEqual({ kind: "none" })
    const drifting = videoSyncAction(input({ ...healthyTicks, videoSec: 12.9 }))
    if (drifting.kind !== "seek") throw new Error("expected a corrective seek")
    expect(drifting.sec).toBeGreaterThan(10.5)
  })

  it("ignores the structural lag that a naive drift bar would chase", () => {
    // Ticks are published on a ~250ms timeupdate, so a perfectly synced video
    // is ALWAYS slightly ahead of the last published tick — by up to 0.25*rate.
    // That is not drift, and correcting it would drag the picture behind.
    expect(
      videoSyncAction(input({ rate: 2, prevTickSec: 10, prevTickAt: 1000, now: 1250, tickSec: 10.5, videoSec: 11.0 })),
    ).toEqual({ kind: "none" })
  })

  it("never seeks to a negative position", () => {
    const back = input({ tickSec: -0.4, prevTickSec: 10, prevTickAt: null })
    expect(videoSyncAction(back)).toEqual({ kind: "seek", sec: 0 })
  })

  // AQU-2253 (review, Nov 9), finding 2: where only the film plays (its tail,
  // or nothing recorded) the film is the clock, and the queue's clock is the
  // film's own second, reported back. So the film is never dragged to a tick:
  // only a real jump of the playhead moves it.
  describe("where the film is the clock", () => {
    it("leaves a film that is near the clock alone, ahead or behind, however stale the tick looks", () => {
      // The clock has not moved for three seconds (the film is buffering).
      const waiting = { filmIsClock: true, tickSec: 10, prevTickSec: 10, prevTickAt: 1000, now: 4000 }
      expect(videoSyncAction(input({ ...waiting, videoSec: 9.4 }))).toEqual({ kind: "none" })
      expect(videoSyncAction(input({ ...waiting, videoSec: 10.6 }))).toEqual({ kind: "none" })
      expect(videoSyncAction(input({ ...waiting, kind: "loading", videoSec: 10.6 }))).toEqual({ kind: "none" })
    })

    it("does not anchor it with a seek on the first beat", () => {
      expect(videoSyncAction(input({ filmIsClock: true, prevTickSec: null, prevTickAt: null, videoSec: 10.1 }))).toEqual({
        kind: "none",
      })
    })

    it("sends it to the playhead when the playhead is put somewhere else, also while the transport waits, and at once", () => {
      const jumped = { filmIsClock: true, tickSec: 30, videoSec: 10.25 }
      expect(videoSyncAction(input(jumped))).toEqual({ kind: "seek", sec: 30 })
      expect(videoSyncAction(input({ ...jumped, kind: "loading" }))).toEqual({ kind: "seek", sec: 30 })
      // No later tick would re-issue a seek dropped for the cooldown: the clock
      // only moves again once the film is there.
      expect(videoSyncAction(input({ ...jumped, lastSeekAt: 1200 }))).toEqual({ kind: "seek", sec: 30 })
    })

    it("a playhead put back a little (Previous line on a short line) takes the film back with it", () => {
      // Half a second back: inside the bar, but this clock never goes back by itself.
      expect(videoSyncAction(input({ filmIsClock: true, tickSec: 9.75, prevTickSec: 10.25, videoSec: 10.3 }))).toEqual({
        kind: "seek",
        sec: 9.75,
      })
      // Already there (the seek has landed): nothing more.
      expect(videoSyncAction(input({ filmIsClock: true, tickSec: 9.75, prevTickSec: 10.25, videoSec: 9.76 }))).toEqual({
        kind: "none",
      })
    })

    it("paused, a small move of the playhead still moves the picture", () => {
      expect(
        videoSyncAction(input({ filmIsClock: true, kind: "paused", tickSec: 10.2, prevTickSec: 10, videoSec: 10 })),
      ).toEqual({ kind: "seek", sec: 10.2 })
    })

    it("still holds the last frame at the film's end, and stops with the queue", () => {
      expect(videoSyncAction(input({ filmIsClock: true, duration: 10, tickSec: 9.9, videoSec: 9.9 }))).toEqual({ kind: "pause" })
      expect(videoSyncAction(input({ filmIsClock: true, kind: "idle" }))).toEqual({ kind: "pause" })
    })
  })
})
