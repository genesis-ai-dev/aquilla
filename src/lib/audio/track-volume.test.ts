// AQU-2664 (board 74): a track's own volume — the fader's scale, its readout,
// where playback applies it, and that every export applies it too.
import { afterEach, describe, expect, it } from "vitest"
import {
  applyPendingVolumes,
  applyTrackVolumes,
  settledPendingVolumes,
  withoutPendingVolume,
  nextPendingVolume,
  pendingVolumesForPatches,
  type PendingVolume,
  formatOwnVolume,
  trackVolumeForSlot,
  trackVolumeOverrides,
  withTrackVolumes,
  FILM_SOUND_TRACK_ID,
  applyFilmSoundDb,
  filmElementVolume,
  filmSoundDb,
  getFilmSoundDb,
  withFilmSoundRow,
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

describe("the readouts", () => {
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

  it("silences a track at −∞", () => {
    applyTrackVolumes([track("trk-music", "audio", -Infinity)])
    expect(trackGainDbOf("trk-music")).toBe(-Infinity)
    expect(Math.pow(10, trackGainDbOf("trk-music") / 20)).toBe(0)
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

  it("writes silence on every sample of a track at −∞, and reads its stored form", () => {
    expect(trackVolumeForSlot({ "trk-music": { kind: "audio", name: "Music", volumeDb: "-inf" } }, "trk-music")).toBe(-Infinity)
    const out = applyClipLevelPcm(new Float32Array([0.5, -0.25]), 48000, { gainDb: 3, trackGainDb: -Infinity })
    expect([...out].every((v) => v === 0)).toBe(true)
    expect(trackVolumeOverrides([track("trk-music", "audio", -Infinity)])["trk-music"]).toEqual({ volumeDb: "-inf" })
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
    expect(levelFields(att)).toMatchObject({ gainDb: -2, trackGainDb: -6 })
    const out = applyClipLevelPcm(new Float32Array([0.5]), 48000, att)
    expect(out[0]).toBeCloseTo(0.5 * Math.pow(10, -8 / 20), 5)
  })
})

describe("a volume written here, before the read shows it", () => {
  const w = (db: number, readBefore: number, id = 1, mine: number[] = []): PendingVolume => ({ db, readBefore, id, mine })

  it("is drawn at once", () => {
    const tracks = [track("target-audio", "target-audio", -9), track("trk-music", "audio")]
    const drawn = applyPendingVolumes(tracks, new Map([["target-audio", w(0, -9)], ["trk-music", w(-3, 0)]]))
    expect(drawn[0].volumeDb).toBeUndefined()
    expect(drawn[1].volumeDb).toBe(-3)
    expect(tracks[0].volumeDb).toBe(-9)
  })

  it("settles when the read shows it (your own write landed)", () => {
    const pending = new Map([["trk-music", w(-3, 0)]])
    expect(settledPendingVolumes(pending, [track("trk-music", "audio")])).toEqual([])
    expect(settledPendingVolumes(pending, [track("trk-music", "audio", -3)])).toEqual(["trk-music"])
  })

  // Review S3: a colleague's newer value wins; the fader shows it.
  it("settles when the read shows a value that is neither the one before nor yours", () => {
    const pending = new Map([["trk-music", w(-3, 0)]])
    expect(settledPendingVolumes(pending, [track("trk-music", "audio", -6)])).toEqual(["trk-music"])
  })

  // Re-check S1: two of your own quick writes; the read shows the first.
  it("stays pending while the read shows one of your own earlier writes", () => {
    const pending = new Map([["trk-music", nextPendingVolume(nextPendingVolume(undefined, -0.5, 0, 1), -1, -0.5, 2)]])
    expect(pending.get("trk-music")).toMatchObject({ db: -1, readBefore: 0, mine: [-0.5] })
    expect(settledPendingVolumes(pending, [track("trk-music", "audio", -0.5)])).toEqual([])
    expect(settledPendingVolumes(pending, [track("trk-music", "audio", -1)])).toEqual(["trk-music"])
    // …and still gives way to a colleague's newer value.
    expect(settledPendingVolumes(pending, [track("trk-music", "audio", -9)])).toEqual(["trk-music"])
  })

  it("settles when the track is gone", () => {
    expect(settledPendingVolumes(new Map([["trk-music", w(-3, 0)]]), [])).toEqual(["trk-music"])
  })

  it("takes back only its own write, not a newer one", () => {
    const pending = new Map([["trk-music", w(-6, 0, 2)]])
    expect(withoutPendingVolume(pending, "trk-music", 1).get("trk-music")?.db).toBe(-6)
    expect(withoutPendingVolume(pending, "trk-music", 2).has("trk-music")).toBe(false)
  })
})

// Sam, Nov 27: the film's row gets a volume slider like every other track's.
// The film's sound is the "source" switch (its M | S), so its volume is stored
// on the Source audio row's id and plays on the "source" mixer stage and on
// the film's own <video> element.
describe("the film's own sound", () => {
  it("is stored on the Source audio row's id, read even when that row is not drawn", () => {
    expect(FILM_SOUND_TRACK_ID).toBe("source-audio")
    expect(filmSoundDb(null)).toBe(0)
    expect(filmSoundDb({ "source-audio": { volumeDb: -6 } })).toBe(-6)
    expect(filmSoundDb({ "source-audio": { volumeDb: "-inf" } })).toBe(-Infinity)
  })

  it("a stand-in row for reads only, when the file draws no Source audio row", () => {
    const drawn = [track("source-subtitles", "source-subtitles"), track("target-audio", "target-audio")]
    const read = withFilmSoundRow(drawn, { "source-audio": { volumeDb: -3 } })
    expect(read.find((t) => t.id === "source-audio")).toMatchObject({ kind: "source-audio", volumeDb: -3 })
    expect(read.slice(0, 2)).toEqual(drawn)
    // A drawn Source audio row is the read as it is.
    const withRow = [track("source-audio", "source-audio", -1)]
    expect(withFilmSoundRow(withRow, { "source-audio": { volumeDb: -3 } })).toBe(withRow)
  })

  it("plays on the mixer's source stage and reaches the film's element", () => {
    applyFilmSoundDb(-6)
    expect(trackGainDbOf("source")).toBe(-6)
    expect(getFilmSoundDb()).toBe(-6)
    applyFilmSoundDb(0)
    expect(getFilmSoundDb()).toBe(0)
  })

  it("the element's volume is the bar's times the film's level, never over 1", () => {
    expect(filmElementVolume(1, 0)).toBe(1)
    expect(filmElementVolume(0.8, -6)).toBeCloseTo(0.8 * Math.pow(10, -6 / 20), 6)
    expect(filmElementVolume(1, 6)).toBe(1)
    expect(filmElementVolume(0.5, -Infinity)).toBe(0)
  })
})

// Evidence pass, Nov 27: an Undo (or Redo) of a volume change wrote the right
// level, but the fader kept showing the dragged one: the drag's own pending
// value was never read back before the Undo's write took the read back to the
// value before it, so it never settled. An Undo's volume write is drawn the
// same way a drag's is.
describe("pendingVolumesForPatches", () => {
  it("draws an Undo's volume over the drag still waiting to be read back", () => {
    const drag = new Map<string, PendingVolume>([["source-audio", nextPendingVolume(undefined, -28.9, -14.9, 1)]])
    const next = pendingVolumesForPatches(drag, [{ trackId: "source-audio", patch: { volumeDb: -14.9 } }], () => -28.9, 2)
    expect(next).not.toBeNull()
    expect(next!.get("source-audio")!.db).toBe(-14.9)
    // Drawn on the track the fader reads.
    expect(applyPendingVolumes([track("source-audio", "source-audio", -28.9)], next!)[0].volumeDb).toBe(-14.9)
    // And it settles once the read shows it.
    expect(settledPendingVolumes(next!, [track("source-audio", "source-audio", -14.9)])).toEqual(["source-audio"])
  })

  it("reads the stored forms: null is 0 dB, \"-inf\" is silence", () => {
    const next = pendingVolumesForPatches(new Map(), [
      { trackId: "a", patch: { volumeDb: null } },
      { trackId: "b", patch: { volumeDb: "-inf" } },
    ], () => -6, 7)!
    expect(next.get("a")!.db).toBe(0)
    expect(next.get("b")!.db).toBe(-Infinity)
    expect(next.get("a")!.readBefore).toBe(-6)
  })

  it("leaves the pending volumes alone when no patch is a volume", () => {
    const pending = new Map<string, PendingVolume>([["a", nextPendingVolume(undefined, -3, 0, 1)]])
    expect(pendingVolumesForPatches(pending, [{ trackId: "a", patch: { color: "red" } }, { trackId: "b", patch: null }], () => 0, 2)).toBeNull()
  })
})
