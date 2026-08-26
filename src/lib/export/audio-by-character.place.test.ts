// Laying takes on the timeline instead of gluing them together. (AQU-646)
//
// Sam, on what the export used to produce: "definitely not sufficient for what
// it's supposed to be." It concatenated each character's takes — forty minutes
// of one voice with no way to tell which line is which. These tests pin the
// thing it should always have been, which codex-editor's
// `characterAudioExporter` had all along: every take at its own second, on
// silence, starting at 0:00 so the tracks drop into a DAW aligned.

import { describe, expect, it } from "vitest"

import { placeClips, trackDurationSec, TRACK_TAIL_PAD_SEC } from "./audio-by-character"

/** A tiny rate keeps the arithmetic readable: 1 sample = 1 second. */
const RATE = 1

const clip = (startSec: number, ...samples: number[]) => ({
  pcm: new Float32Array(samples),
  startSec,
})

describe("placing takes on the timeline", () => {
  it("puts silence before a take that starts late", () => {
    // THE WHOLE POINT. The old export would have returned [1] — the take with
    // no idea where it belonged.
    const track = placeClips([clip(3, 1)], 4, RATE)
    expect(Array.from(track)).toEqual([0, 0, 0, 32767])
  })

  it("starts every track at 0:00, not at the character's first line", () => {
    // What makes two characters' files line up with each other and with the
    // film when they are dropped onto adjacent DAW tracks.
    const early = placeClips([clip(1, 1)], 5, RATE)
    const late = placeClips([clip(4, 1)], 5, RATE)
    expect(early.length).toBe(late.length)
    expect(early[1]).toBeGreaterThan(0)
    expect(late[4]).toBeGreaterThan(0)
  })

  it("keeps the silence between two lines", () => {
    const track = placeClips([clip(0, 1), clip(3, -1)], 4, RATE)
    expect(Array.from(track)).toEqual([32767, 0, 0, -32768])
  })

  it("sums overlapping takes rather than letting one win", () => {
    // Two characters talking over each other is real in this material, and
    // within ONE character a combined take can overlap a solo line. Dropping
    // either would delete recorded audio.
    const track = placeClips([clip(0, 0.25), clip(0, 0.25)], 1, RATE)
    expect(track[0]).toBe(quantised(0.25) * 2)
  })

  it("saturates instead of wrapping when the sum is too loud", () => {
    // Wrapping past the 16-bit ceiling flips the sign, which is heard as a
    // click — far worse than the loudness it is trying to represent.
    const track = placeClips([clip(0, 1), clip(0, 1), clip(0, 1)], 1, RATE)
    expect(track[0]).toBe(32767)
    const floor = placeClips([clip(0, -1), clip(0, -1), clip(0, -1)], 1, RATE)
    expect(floor[0]).toBe(-32768)
  })

  it("quantises exactly as a live take does", () => {
    // `quantisePcm16` is shared with the capture worklet, so an exported clip
    // and a recorded one of the same audio land on identical samples.
    const track = placeClips([clip(0, 0.5, -0.5, 0)], 3, RATE)
    expect(Array.from(track)).toEqual([quantised(0.5), quantised(-0.5), 0])
  })

  it("clips a take that would run past the end of the track", () => {
    const track = placeClips([clip(2, 1, 1, 1, 1)], 3, RATE)
    expect(track.length).toBe(3)
    expect(Array.from(track)).toEqual([0, 0, 32767])
  })

  it("ignores a take that begins after the track has ended", () => {
    const track = placeClips([clip(9, 1)], 3, RATE)
    expect(Array.from(track)).toEqual([0, 0, 0])
  })

  it("treats a negative start as the very beginning", () => {
    const track = placeClips([clip(-2, 1)], 2, RATE)
    expect(track[0]).toBe(32767)
  })

  it("returns nothing for a track of no length", () => {
    expect(placeClips([clip(0, 1)], 0, RATE).length).toBe(0)
  })

  it("is silence when there is nothing to place", () => {
    expect(Array.from(placeClips([], 3, RATE))).toEqual([0, 0, 0])
  })
})

describe("how long a character's track runs", () => {
  it("reaches the end of the last take, plus a pad", () => {
    expect(trackDurationSec([{ startSec: 10, lengthSec: 2 }])).toBe(12 + TRACK_TAIL_PAD_SEC)
  })

  it("does NOT truncate a take that overran its cue window", () => {
    // codex-editor clamps to the cue (ffmpeg's `duration=first`), which cuts
    // the tail off a performance that ran long. Losing recorded audio to save
    // a second of silence is the wrong trade in something being mixed.
    const sec = trackDurationSec([{ startSec: 10, lengthSec: 5, endSec: 12 }])
    expect(sec).toBe(15 + TRACK_TAIL_PAD_SEC)
  })

  it("reaches the end of the cue window when the take falls short of it", () => {
    // The other direction: a line whose recording is shorter than its window
    // still owns the window, so the silence after it is real.
    const sec = trackDurationSec([{ startSec: 10, lengthSec: 1, endSec: 14 }])
    expect(sec).toBe(14 + TRACK_TAIL_PAD_SEC)
  })

  it("takes the latest ending of several takes", () => {
    const sec = trackDurationSec([
      { startSec: 100, lengthSec: 1 },
      { startSec: 10, lengthSec: 2 },
    ])
    expect(sec).toBe(101 + TRACK_TAIL_PAD_SEC)
  })

  it("is zero — not just a pad — for a character with nothing placed", () => {
    expect(trackDurationSec([])).toBe(0)
  })
})

/** The exporter's own quantisation, duplicated here so the expectations read
 *  as numbers rather than as a re-implementation under test. */
function quantised(v: number): number {
  return Math.round(v * (v < 0 ? 0x8000 : 0x7fff))
}
