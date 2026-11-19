// AQU-2664: the ONE rule for how loud a take plays, read by the playback
// mixer and by every export: its own volume, plus the evening-out correction
// that takes its measured loudness to the target, held inside a range and
// under the peak ceiling.
import { describe, expect, it } from "vitest"
import { DEFAULT_EVEN_TARGET_LUFS, MAX_EVEN_CORRECTION_DB, PEAK_CEILING_DBTP, takeGain, takeGainDb } from "./take-gain"
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

  it("never moves a take by more than the range, either way", () => {
    expect(MAX_EVEN_CORRECTION_DB).toBe(20)
    const up = takeGain({ loudnessLufs: -50, truePeakDb: -45, evenTargetLufs: -16 })
    expect(up.correctionDb).toBe(20)
    expect(up.wantedDb).toBeCloseTo(34, 6)
    expect(up.held).toBe("range")
    const down = takeGain({ loudnessLufs: 8, truePeakDb: 0, evenTargetLufs: -16 })
    expect(down.correctionDb).toBe(-20)
    expect(down.held).toBe("range")
  })

  it("raises a take only as far as its true peak stays under -1 dBTP", () => {
    expect(PEAK_CEILING_DBTP).toBe(-1)
    // Wants +8, but its peak is at -4: only 3 dB of room.
    const g = takeGain({ loudnessLufs: -24, truePeakDb: -4, evenTargetLufs: -16 })
    expect(g.wantedDb).toBeCloseTo(8, 6)
    expect(g.correctionDb).toBeCloseTo(3, 6)
    expect(g.held).toBe("peak")
    expect(g.gainDb + -4).toBeCloseTo(PEAK_CEILING_DBTP, 6)
  })

  it("counts the take's own volume against the peak room", () => {
    const g = takeGain({ gainDb: 2, loudnessLufs: -24, truePeakDb: -6, evenTargetLufs: -16 })
    // Room after its own +2: -1 - (-6 + 2) = 3.
    expect(g.correctionDb).toBeCloseTo(3, 6)
    expect(g.gainDb).toBeCloseTo(5, 6)
  })

  it("never turns a take down for the peak: its own volume is the person's call", () => {
    const g = takeGain({ gainDb: 6, loudnessLufs: -20, truePeakDb: -3, evenTargetLufs: -16 })
    expect(g.correctionDb).toBe(0)
    expect(g.gainDb).toBe(6)
    expect(g.held).toBe("peak")
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
