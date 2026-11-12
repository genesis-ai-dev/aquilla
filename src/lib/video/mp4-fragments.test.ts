import { describe, expect, it } from "vitest"

import { fragmentStartSec, readFragmentTiming, readInitTracks } from "./mp4-fragments"
import { buildFragment, buildInit } from "./__fixtures__/fmp4"

// AQU-1681. WHY: a streamed film's sound is decoded a minute at a time, and
// each minute is cut back to the length its fragments DECLARE so a decoder's
// edge padding cannot pile up and slide later rows off the picture. The
// playlist's EXTINF is not trustworthy for that (packagers round it), so the
// lengths come from the boxes — and so does where each stream's clock starts,
// which is how a sound that does not start with the picture is caught.
//
// The geometry mirrors episode 101's real English rendition: 48 kHz, 1024-
// sample AAC frames, 187 or 188 frames per fragment, flags 0x2002a/0x201.

describe("readInitTracks", () => {
  it("reads the track id, handler, timescale and trex default duration", () => {
    expect(readInitTracks(buildInit({ timescale: 48_000, defaultSampleDuration: 1024 }))).toEqual([
      { trackId: 1, handler: "soun", timescale: 48_000, defaultSampleDuration: 1024 },
    ])
  })

  it("reads 64-bit (version 1) headers", () => {
    const [track] = readInitTracks(buildInit({ timescale: 25_000, handler: "vide", trackId: 2, version1: true }))
    expect(track).toMatchObject({ trackId: 2, handler: "vide", timescale: 25_000 })
  })

  it("answers nothing for bytes that are not an init segment", () => {
    expect(readInitTracks(new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]))).toEqual([])
  })
})

describe("readFragmentTiming", () => {
  const tracks = readInitTracks(buildInit({ timescale: 48_000, defaultSampleDuration: 1024 }))

  it("sums a fragment from the trex default when neither tfhd nor trun states one", () => {
    const frag = buildFragment({ decodeTime: 191_488, sampleCount: 188, level: 1 })
    expect(readFragmentTiming(frag, tracks)).toEqual([
      { trackId: 1, baseMediaDecodeTime: 191_488, durationTicks: 188 * 1024 },
    ])
  })

  it("prefers the tfhd default, and per-sample durations over both", () => {
    expect(readFragmentTiming(buildFragment({ decodeTime: 0, sampleCount: 10, sampleDuration: 960, level: 1 }), tracks)[0])
      .toMatchObject({ durationTicks: 9600 })
    expect(readFragmentTiming(
      buildFragment({ decodeTime: 0, sampleCount: 3, sampleDuration: 960, perSampleDurations: [1024, 1024, 512], level: 1 }),
      tracks,
    )[0]).toMatchObject({ durationTicks: 2560 })
  })

  it("reads a 64-bit tfdt", () => {
    const frag = buildFragment({ decodeTime: 157_824_000, sampleCount: 4, version1: true, level: 0 })
    expect(readFragmentTiming(frag, tracks)[0]).toMatchObject({ baseMediaDecodeTime: 157_824_000 })
  })
})

describe("fragmentStartSec", () => {
  it("puts a fragment on its own track's clock", () => {
    const init = buildInit({ timescale: 25_000, handler: "vide", defaultSampleDuration: 1000 })
    expect(fragmentStartSec(init, buildFragment({ decodeTime: 250_000, sampleCount: 100, level: 0 }), "vide")).toBe(10)
  })

  it("still reads a fragment header cut short by a ranged read", () => {
    const init = buildInit({ timescale: 48_000, defaultSampleDuration: 1024 })
    const frag = buildFragment({ decodeTime: 96_000, sampleCount: 188, level: 1 })
    // Drop the mdat: what a 64 KB ranged read of a large fragment returns.
    expect(fragmentStartSec(init, frag.subarray(0, frag.byteLength - 9), "soun")).toBe(2)
  })
})
