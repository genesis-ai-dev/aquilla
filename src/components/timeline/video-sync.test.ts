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
})
