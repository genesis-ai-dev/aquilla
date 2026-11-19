// AQU-2664 (board 74): a track's own volume — the fader's scale, its readout,
// where playback applies it, and that every export applies it too.
import { afterEach, describe, expect, it } from "vitest"
import {
  TRACK_VOLUME_MAX_DB,
  TRACK_VOLUME_MIN_DB,
  applyPendingVolumes,
  applyTrackVolumes,
  settledPendingVolumes,
  clampTrackVolumeDb,
  faderDb,
  faderPos,
  formatFaderDb,
  formatOwnVolume,
  trackVolumeForSlot,
  trackVolumeOverrides,
  withTrackVolumes,
} from "./track-volume"
import { __resetMixerForTests, trackGainDbOf } from "./mixer"
import { applyClipLevelPcm, hasClipLevel, levelFields } from "@/lib/export/clip-level"
import { GENERATED_VOICE_SLOT, RECORDING_SLOT } from "@/lib/timeline/track-slots"
import type { TimelineTrack } from "@/lib/timeline/tracks"
import type { CellData } from "@/hooks/useCells"

afterEach(() => __resetMixerForTests())

const track = (id: string, kind: TimelineTrack["kind"], volumeDb?: number): TimelineTrack => ({
  id, kind, name: id, order: 0, ...(volumeDb != null ? { volumeDb } : {}),
})

describe("the fader's scale (board 74 FADER_STOPS)", () => {
  it.each([
    [-60, 0], [-48, 0.08], [-36, 0.17], [-24, 0.3], [-18, 0.39], [-12, 0.5], [-6, 0.65], [0, 0.82], [6, 1],
  ])("puts %s dB at %s", (db, pos) => {
    expect(faderPos(db)).toBeCloseTo(pos, 6)
    expect(faderDb(pos)).toBeCloseTo(db, 6)
  })

  it("is linear between stops and stops at both ends", () => {
    expect(faderPos(-3)).toBeCloseTo((0.65 + 0.82) / 2, 6)
    expect(faderPos(-90)).toBe(0)
    expect(faderPos(20)).toBe(1)
    expect(faderDb(-1)).toBe(TRACK_VOLUME_MIN_DB)
    expect(faderDb(2)).toBe(TRACK_VOLUME_MAX_DB)
  })

  it("clamps typed values into −60…+6 and rounds to a tenth", () => {
    expect(clampTrackVolumeDb(-99)).toBe(-60)
    expect(clampTrackVolumeDb(9)).toBe(6)
    expect(clampTrackVolumeDb(-4.46)).toBe(-4.5)
    expect(clampTrackVolumeDb(Number.NaN)).toBe(0)
  })
})

describe("the readouts", () => {
  it("reads the fader as the board does", () => {
    expect(formatFaderDb(0)).toBe("0.0 dB")
    expect(formatFaderDb(-4.5)).toBe("−4.5 dB")
    expect(formatFaderDb(2)).toBe("+2.0 dB")
  })

  it("reads a take's own volume as the Station line does", () => {
    expect(formatOwnVolume(0)).toBe("0 dB")
    expect(formatOwnVolume(-2)).toBe("−2 dB")
    expect(formatOwnVolume(1.5)).toBe("+1.5 dB")
  })
})

describe("playback: the mixer's track stage", () => {
  it("gives the main track's volume to both of its slots, and an added track's to its own", () => {
    applyTrackVolumes([track("target-audio", "target-audio", -9), track("trk-music", "audio", 3), track("source-subtitles", "source-subtitles")])
    expect(trackGainDbOf(RECORDING_SLOT)).toBe(-9)
    expect(trackGainDbOf(GENERATED_VOICE_SLOT)).toBe(-9)
    expect(trackGainDbOf("trk-music")).toBe(3)
  })

  it("puts a track back to 0 dB when its volume is cleared", () => {
    applyTrackVolumes([track("trk-music", "audio", 3)])
    applyTrackVolumes([track("trk-music", "audio")])
    expect(trackGainDbOf("trk-music")).toBe(0)
  })
})

describe("exports: every clip carries its track's volume", () => {
  const cells = [
    {
      id: "c1",
      attachments: {
        a1: { url: "u1", type: "audio/webm", slot: RECORDING_SLOT, gainDb: -2 },
        a2: { url: "u2", type: "audio/webm", slot: GENERATED_VOICE_SLOT },
        a3: { url: "u3", type: "audio/webm", slot: "trk-music" },
      },
    },
  ] as unknown as CellData[]
  const overrides = { "target-audio": { volumeDb: -6 }, "trk-music": { kind: "audio", name: "Music", volumeDb: 0 } }

  it("finds a slot's track volume", () => {
    expect(trackVolumeForSlot(overrides, RECORDING_SLOT)).toBe(-6)
    expect(trackVolumeForSlot(overrides, GENERATED_VOICE_SLOT)).toBe(-6)
    expect(trackVolumeForSlot(overrides, "trk-music")).toBe(0)
    expect(trackVolumeForSlot(null, "trk-music")).toBe(0)
  })

  it("reads the drawn tracks the same way", () => {
    const o = trackVolumeOverrides([track("target-audio", "target-audio", -6), track("trk-music", "audio")])
    expect(trackVolumeForSlot(o, RECORDING_SLOT)).toBe(-6)
    expect(o["trk-music"]).toBeUndefined()
  })

  it("stamps each take with it, leaving the cells it was given alone", () => {
    const out = withTrackVolumes(cells, overrides)
    const a = out[0].attachments as Record<string, { trackGainDb?: number }>
    expect(a.a1.trackGainDb).toBe(-6)
    expect(a.a2.trackGainDb).toBe(-6)
    expect(a.a3.trackGainDb).toBeUndefined()
    expect((cells[0].attachments as Record<string, { trackGainDb?: number }>).a1.trackGainDb).toBeUndefined()
    expect(withTrackVolumes(cells, null)).toBe(cells)
  })

  it("applies it after the take's own volume, in the PCM and the level fields", () => {
    const att = { gainDb: -2, trackGainDb: -6 }
    expect(hasClipLevel({ trackGainDb: -6 })).toBe(true)
    expect(levelFields(att).gainDb).toBeCloseTo(-8, 6)
    const out = applyClipLevelPcm(new Float32Array([0.5]), 48000, att)
    expect(out[0]).toBeCloseTo(0.5 * Math.pow(10, -8 / 20), 5)
  })
})

describe("a volume written here, before the read shows it", () => {
  it("is drawn at once, and dropped when the read agrees", () => {
    const tracks = [track("target-audio", "target-audio", -9), track("trk-music", "audio")]
    const pending = new Map([["target-audio", 0], ["trk-music", -3]])
    const drawn = applyPendingVolumes(tracks, pending)
    expect(drawn[0].volumeDb).toBeUndefined()
    expect(drawn[1].volumeDb).toBe(-3)
    expect(tracks[0].volumeDb).toBe(-9)
    expect(settledPendingVolumes(pending, tracks)).toEqual([])
    expect(settledPendingVolumes(pending, drawn)).toEqual(["target-audio", "trk-music"])
  })
})
