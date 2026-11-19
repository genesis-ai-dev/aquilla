// AQU-2664: the ONE rule for how loud a take plays, read by the playback
// mixer and by every export, in Sam's stage order (Nov 19): the recording,
// then the evening-out correction (its own stage, like Logic's region gain),
// then the take's own volume and fades, then the track, main and peak guard.
// The correction depends on the recording and the target ALONE, so a user's
// volume reads relative to the evened level: 0 dB means "as evened".
import { describe, expect, it } from "vitest"
import { DEFAULT_EVEN_TARGET_LUFS, MAX_EVEN_CUT_DB, MAX_EVEN_RAISE_DB, PEAK_CEILING_DBTP, takeGain, takeGainDb } from "./take-gain"
import { SILENT_LUFS } from "./loudness"

describe("a take's gain", () => {
  it("is its own volume when it isn't evened out", () => {
    expect(takeGainDb({})).toBe(0)
    expect(takeGainDb({ gainDb: -4 })).toBe(-4)
    expect(takeGainDb({ gainDb: -4, loudnessLufs: -30, truePeakDb: -20 })).toBe(-4)
  })

  it("defaults the target to -16 LUFS", () => {
    expect(DEFAULT_EVEN_TARGET_LUFS).toBe(-16)
  })

  it("adds target minus measured loudness when evened out", () => {
    const g = takeGain({ loudnessLufs: -24, truePeakDb: -12, evenTargetLufs: -16 })
    expect(g.correctionDb).toBeCloseTo(8, 6)
    expect(g.gainDb).toBeCloseTo(8, 6)
    expect(g.held).toBeNull()
  })

  it("turns a loud take down to the target", () => {
    const g = takeGain({ loudnessLufs: -9, truePeakDb: -0.2, evenTargetLufs: -16 })
    expect(g.gainDb).toBeCloseTo(-7, 6)
    expect(g.held).toBeNull()
  })

  it("keeps the take's own volume on top of the correction", () => {
    expect(takeGainDb({ gainDb: -3, loudnessLufs: -24, truePeakDb: -12, evenTargetLufs: -16 })).toBeCloseTo(5, 6)
    expect(takeGainDb({ gainDb: 2, loudnessLufs: -10, truePeakDb: -3, evenTargetLufs: -16 })).toBeCloseTo(-4, 6)
  })

  it("does nothing until the take is measured", () => {
    const g = takeGain({ gainDb: -2, evenTargetLufs: -16 })
    expect(g.gainDb).toBe(-2)
    expect(g.correctionDb).toBe(0)
    expect(g.measured).toBe(false)
  })

  it("does nothing for a silent take (nothing above the -70 LUFS gate)", () => {
    const g = takeGain({ loudnessLufs: SILENT_LUFS, truePeakDb: -90, evenTargetLufs: -16 })
    expect(g.gainDb).toBe(0)
    expect(g.correctionDb).toBe(0)
  })

  it("never raises a take by more than +12 dB, nor cuts it by more than 20", () => {
    expect(MAX_EVEN_RAISE_DB).toBe(12)
    expect(MAX_EVEN_CUT_DB).toBe(20)
    const up = takeGain({ loudnessLufs: -50, truePeakDb: -45, evenTargetLufs: -16 })
    expect(up.correctionDb).toBe(12)
    expect(up.wantedDb).toBeCloseTo(34, 6)
    expect(up.held).toBe("range")
    const down = takeGain({ loudnessLufs: 8, truePeakDb: 0, evenTargetLufs: -16 })
    expect(down.correctionDb).toBe(-20)
    expect(down.held).toBe("range")
  })

  it("the +12 cap is the correction's alone: the take's own volume goes on top of it", () => {
    const g = takeGain({ gainDb: 6, loudnessLufs: -50, truePeakDb: -45, evenTargetLufs: -16 })
    expect(g.correctionDb).toBe(12)
    expect(g.gainDb).toBe(18)
  })

  it("raises a take only as far as the recording's true peak stays under -1 dBTP", () => {
    expect(PEAK_CEILING_DBTP).toBe(-1)
    // Wants +8, but its peak is at -4: only 3 dB of room.
    const g = takeGain({ loudnessLufs: -24, truePeakDb: -4, evenTargetLufs: -16 })
    expect(g.wantedDb).toBeCloseTo(8, 6)
    expect(g.correctionDb).toBeCloseTo(3, 6)
    expect(g.held).toBe("peak")
  })

  it("the correction never depends on the take's own volume: 0 dB means as evened", () => {
    const base = { loudnessLufs: -24, truePeakDb: -6, evenTargetLufs: -16 }
    for (const gainDb of [-12, -3, 0, 2, 6]) {
      const g = takeGain({ ...base, gainDb })
      expect(g.correctionDb).toBeCloseTo(5, 6) // room: -1 - (-6)
      expect(g.gainDb).toBeCloseTo(5 + gainDb, 6)
      expect(g.ownDb).toBe(gainDb)
    }
  })

  it("lists the stages in the order they apply", () => {
    const g = takeGain({ gainDb: -3, loudnessLufs: -24, truePeakDb: -12, evenTargetLufs: -16 })
    expect(g.stages).toEqual([{ stage: "evenOut", db: 8 }, { stage: "ownVolume", db: -3 }])
  })

  it("doesn't raise a take whose peak is unknown", () => {
    const g = takeGain({ loudnessLufs: -24, evenTargetLufs: -16 })
    expect(g.correctionDb).toBe(0)
    expect(takeGain({ loudnessLufs: -10, evenTargetLufs: -16 }).correctionDb).toBeCloseTo(-6, 6)
  })

  it("reads stored nulls as absent", () => {
    expect(takeGainDb({ gainDb: null, loudnessLufs: null, truePeakDb: null, evenTargetLufs: null })).toBe(0)
  })
})
