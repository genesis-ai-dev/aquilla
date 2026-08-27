// AQU-646 round 5: the rule that decides which engine is playing a file.
//
// Sam's report was five symptoms with one cause — the bottom bar, the dialogue
// table and the timeline were each wired to one of two transports, arbitrarily,
// so on a video-first file the bar read "paused / 0:00" while the picture ran.
// These pin the fold so a future consumer cannot be wired to the wrong half.

import { describe, it, expect } from "vitest"
import { selectTransportForFile, videoOwnsFile, type VideoTransportInput } from "./transport"
import type { QueueForFile } from "./queue-scope"

const idleQueue: QueueForFile = {
  active: false,
  playing: false,
  running: false,
  cellId: null,
  kind: "idle",
  errorMessage: null,
  progress: { currentTime: 0, duration: 0, rate: 1, volume: 1 },
}

const runningQueue: QueueForFile = {
  active: true,
  playing: true,
  running: true,
  cellId: "c9",
  kind: "playing",
  errorMessage: null,
  progress: { currentTime: 4, duration: 10, rate: 1.5, volume: 0.8 },
}

const video = (over: Partial<VideoTransportInput> = {}): VideoTransportInput => ({
  currentSec: 41.8,
  playing: true,
  durationSec: 4212,
  soundingCellId: "cue-3",
  rate: 1,
  volume: 1,
  buffering: false,
  ...over,
})

describe("videoOwnsFile", () => {
  it("a linked picture with no imported recording — the video-first file", () => {
    expect(videoOwnsFile("https://cdn/master.m3u8", false, true)).toBe(true)
  })

  it("no picture — the queue owns it, as everywhere else in the app", () => {
    expect(videoOwnsFile(null, false, true)).toBe(false)
    expect(videoOwnsFile(undefined, false, true)).toBe(false)
  })

  it("a picture AND an imported recording — the recording is the master", () => {
    // A dubbing file that also has footage linked: the queue's clock IS file
    // time there, so the picture is slaved to it rather than driving.
    expect(videoOwnsFile("https://cdn/master.m3u8", true, true)).toBe(false)
  })

  it("a picture with NO PANE on screen — the queue owns it", () => {
    // Round 6. The pane is what registers the controller, so where it is hidden
    // (Free timing, or a file that is not time-ordered) there is nothing to
    // drive. The bar used to claim the video transport here anyway and then
    // find no controller behind it — every control on it dead, on a file whose
    // queue could have played it perfectly well.
    expect(videoOwnsFile("https://cdn/master.m3u8", false, false)).toBe(false)
  })
})

describe("selectTransportForFile", () => {
  it("with no video, it is the queue's answer verbatim", () => {
    // The guarantee that every other file type is untouched by this work.
    expect(selectTransportForFile(runningQueue, null)).toEqual({ ...runningQueue, source: "queue" })
    expect(selectTransportForFile(idleQueue, null)).toEqual({ ...idleQueue, source: "queue" })
  })

  it("reports the FILM's clock when the picture owns the file", () => {
    const t = selectTransportForFile(idleQueue, video())
    expect(t.source).toBe("video")
    expect(t.playing).toBe(true)
    expect(t.progress.currentTime).toBe(41.8)
    expect(t.progress.duration).toBe(4212)
    expect(t.cellId).toBe("cue-3")
    expect(t.kind).toBe("playing")
  })

  it("this is the fix for the bar reading 0:00 while the film runs", () => {
    // Before: the bar read the idle queue's progress — currentTime 0,
    // duration 0 — which is why it said "paused / 0:00 / 0:00".
    const t = selectTransportForFile(idleQueue, video())
    expect(idleQueue.progress.currentTime).toBe(0)
    expect(t.progress.currentTime).toBeGreaterThan(0)
    expect(t.progress.duration).toBeGreaterThan(0)
  })

  it("a paused film is active but not playing — so the bar shows its position", () => {
    const t = selectTransportForFile(idleQueue, video({ playing: false }))
    expect(t.active).toBe(true)
    expect(t.playing).toBe(false)
    expect(t.running).toBe(false)
    expect(t.kind).toBe("paused")
    expect(t.progress.currentTime).toBe(41.8)
  })

  it("a cleared clock is idle, and on no line", () => {
    const t = selectTransportForFile(idleQueue, video({ currentSec: null }))
    expect(t.active).toBe(false)
    expect(t.kind).toBe("idle")
    expect(t.cellId).toBeNull()
  })

  it("no line under the playhead in a silence", () => {
    expect(selectTransportForFile(idleQueue, video({ soundingCellId: null })).cellId).toBeNull()
  })

  it("a duration that has not landed yet reads 0, never NaN", () => {
    expect(selectTransportForFile(idleQueue, video({ durationSec: undefined })).progress.duration).toBe(0)
    expect(selectTransportForFile(idleQueue, video({ durationSec: null })).progress.duration).toBe(0)
    expect(selectTransportForFile(idleQueue, video({ durationSec: NaN })).progress.duration).toBe(0)
  })

  it("a RUNNING queue still wins on a video-owned file", () => {
    // Same precedence the video pane's caption already uses. If the two
    // disagreed, the caption and the bar would name different lines.
    const t = selectTransportForFile(runningQueue, video())
    expect(t.source).toBe("queue")
    expect(t.cellId).toBe("c9")
    expect(t.progress.currentTime).toBe(4)
  })

  it("a picture getting ready to start reports LOADING, not paused", () => {
    // Round 6. Pressing play right after scrubbing used to look like nothing
    // happening at all: the element was seeking, the bar had only
    // playing-or-paused to say, and it said paused.
    const t = selectTransportForFile(idleQueue, video({ playing: false, buffering: true }))
    expect(t.kind).toBe("loading")
    expect(t.active).toBe(true)
    expect(t.playing).toBe(false)
    // A cold start is a dip to protect, exactly as it is for the queue:
    // follow/re-engage must not read the wait for a seek as a stop.
    expect(t.running).toBe(true)
    // ...and it still reports where the film is, so the readout does not blank.
    expect(t.progress.currentTime).toBe(41.8)
  })

  it("a picture that is already sounding is never LOADING", () => {
    // Rebuffering mid-play is the element's own business. Flipping the bar's
    // button to a spinner under a running film would be a lie about the
    // transport, and would make the button mean "cancel" while it plays.
    expect(selectTransportForFile(idleQueue, video({ playing: true, buffering: true })).kind).toBe("playing")
  })

  it("the FIRST press on a freshly opened film reports loading, not idle", () => {
    // Caught in review. On a file just opened, nothing has ticked or seeked, so
    // the clock has no position yet — and `active` used to require one. The
    // press armed the readiness wait but the bar reported `idle`, which cost
    // two things: no spinner, and — because the bar's press-again-to-cancel
    // branch keys on `loading` — every further press re-armed the wait instead
    // of ending it. An impatient user could defer their own playback forever
    // and never cancel it, while Space (which reads the pane directly) did
    // cancel. The two controls disagreed about what a press meant.
    // Nothing has published a position OR a line — both come from the same
    // events, so a cold clock has neither.
    const t = selectTransportForFile(
      idleQueue,
      video({ currentSec: null, soundingCellId: null, playing: false, buffering: true }),
    )
    expect(t.kind).toBe("loading")
    expect(t.active).toBe(true)
    expect(t.running).toBe(true)
    // No position to report yet, and no line under a playhead that has none.
    expect(t.progress.currentTime).toBe(0)
    expect(t.cellId).toBeNull()
  })

  it("a cleared clock with nothing pending is idle", () => {
    const t = selectTransportForFile(idleQueue, video({ currentSec: null, playing: false }))
    expect(t.kind).toBe("idle")
    expect(t.active).toBe(false)
    expect(t.running).toBe(false)
  })

  it("a RUNNING queue still wins over a buffering picture", () => {
    expect(selectTransportForFile(runningQueue, video({ playing: false, buffering: true })).source).toBe("queue")
  })

  it("reports the picture's own rate and volume, not the queue's stale ones", () => {
    // Showing an idle queue's 1.5x would be a readout about a transport that is
    // not sounding. The picture's values are mirrored from the element, so the
    // bar and the native controls can never disagree.
    const t = selectTransportForFile(
      { ...idleQueue, progress: runningQueue.progress },
      video({ rate: 0.5, volume: 0.25 }),
    )
    expect(t.progress.rate).toBe(0.5)
    expect(t.progress.volume).toBe(0.25)
  })
})
