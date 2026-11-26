// AQU-2664: how a track's fader value is kept — what the fader may hold, and
// its stored form on the file's track (`file.track.set` `volumeDb`).
import { describe, expect, it } from "vitest"
import { SILENT_VOLUME, TRACK_VOLUME_FLOOR_DB, clampTrackVolumeDb, fromStoredVolume, toStoredVolume } from "./track-volume-store"
import { overrideVolumeDb } from "@/lib/timeline/tracks"

describe("what the fader holds", () => {
  it("rounds to a tenth, holds +6 at the top, keeps −∞, and reads junk as 0", () => {
    expect(clampTrackVolumeDb(-4.46)).toBe(-4.5)
    expect(clampTrackVolumeDb(40)).toBe(6)
    expect(clampTrackVolumeDb(-Infinity)).toBe(-Infinity)
    expect(clampTrackVolumeDb(Number.NaN)).toBe(0)
  })

  it("is −∞ below the floor", () => {
    expect(clampTrackVolumeDb(TRACK_VOLUME_FLOOR_DB)).toBe(TRACK_VOLUME_FLOOR_DB)
    expect(clampTrackVolumeDb(TRACK_VOLUME_FLOOR_DB - 1)).toBe(-Infinity)
  })
})

describe("the stored form", () => {
  it("is nothing for 0 dB, the number for a level, and \"-inf\" for silence", () => {
    expect(SILENT_VOLUME).toBe("-inf")
    expect(toStoredVolume(0)).toBeNull()
    expect(toStoredVolume(-4.5)).toBe(-4.5)
    expect(toStoredVolume(-Infinity)).toBe("-inf")
  })

  it("reads back what it stores, and junk as none", () => {
    expect(fromStoredVolume("-inf")).toBe(-Infinity)
    expect(fromStoredVolume(-4.5)).toBe(-4.5)
    expect(fromStoredVolume(-70)).toBe(-70)
    expect(fromStoredVolume(null)).toBeUndefined()
    expect(fromStoredVolume("loud")).toBeUndefined()
    expect(fromStoredVolume(40)).toBeUndefined()
    expect(fromStoredVolume(TRACK_VOLUME_FLOOR_DB - 1)).toBeUndefined()
    expect(fromStoredVolume(Number.NaN)).toBeUndefined()
  })

  it("agrees with the track merge's own reading (tracks.ts has no imports)", () => {
    for (const v of ["-inf", -4.5, 0, 6, -70, TRACK_VOLUME_FLOOR_DB, TRACK_VOLUME_FLOOR_DB - 1, 40, "x", null, Number.NaN, -Infinity]) {
      expect(overrideVolumeDb(v), String(v)).toBe(fromStoredVolume(v))
    }
  })
})
