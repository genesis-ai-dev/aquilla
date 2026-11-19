// AQU-2664: the loudness meter (ITU-R BS.1770 / EBU R128 integrated loudness,
// plus a 4x oversampled true peak), checked against signals whose loudness is
// known: the EBU Tech 3341 minimum-requirement cases and plain sines.
import { describe, expect, it } from "vitest"
import { kWeighting, measureLoudness, SILENT_LUFS } from "./loudness"

const dbToAmp = (db: number) => Math.pow(10, db / 20)

/** A sine of `seconds`, its peak at `dbfs`, at `rate`. */
function sine(seconds: number, dbfs: number, rate = 48_000, hz = 1000, phase = 0): Float32Array {
  const n = Math.round(seconds * rate)
  const a = dbToAmp(dbfs)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = a * Math.sin((2 * Math.PI * hz * i) / rate + phase)
  return out
}

function join(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

describe("K-weighting", () => {
  it("is the published BS.1770 filter pair at 48 kHz", () => {
    const k = kWeighting(48_000)
    // ITU-R BS.1770-5, tables 1 and 2.
    expect(k.shelf.b[0]).toBeCloseTo(1.53512485958697, 8)
    expect(k.shelf.b[1]).toBeCloseTo(-2.69169618940638, 8)
    expect(k.shelf.b[2]).toBeCloseTo(1.19839281085285, 8)
    expect(k.shelf.a[1]).toBeCloseTo(-1.69065929318241, 8)
    expect(k.shelf.a[2]).toBeCloseTo(0.73248077421585, 8)
    expect(k.highPass.b).toEqual([1, -2, 1])
    expect(k.highPass.a[1]).toBeCloseTo(-1.99004745483398, 8)
    expect(k.highPass.a[2]).toBeCloseTo(0.99007225036621, 8)
  })
})

describe("integrated loudness", () => {
  // Sam, Nov 19: a mono take is measured as it will be heard — on both
  // speakers, dual mono (BS.1770: +3 LU) — so a mono sine reads what the same
  // sine on both channels of a stereo file reads.
  it("reads a mono 1 kHz sine at -23 dBFS as -23 LUFS, as heard on both speakers", () => {
    const r = measureLoudness([sine(20, -23)], 48_000)
    expect(Math.abs(r.integratedLufs - -23)).toBeLessThan(0.1)
  })

  it("a mono take and a stereo take of the same sound read the same", () => {
    const s = sine(10, -20)
    const mono = measureLoudness([s], 48_000).integratedLufs
    const stereo = measureLoudness([s, s], 48_000).integratedLufs
    expect(Math.abs(mono - stereo)).toBeLessThan(0.01)
  })

  it("Tech 3341 case 1: a stereo 1 kHz sine at -23 dBFS is -23 LUFS", () => {
    const s = sine(20, -23)
    expect(Math.abs(measureLoudness([s, s], 48_000).integratedLufs - -23)).toBeLessThan(0.1)
  })

  it("Tech 3341 case 2: a stereo 1 kHz sine at -33 dBFS is -33 LUFS", () => {
    const s = sine(20, -33)
    expect(Math.abs(measureLoudness([s, s], 48_000).integratedLufs - -33)).toBeLessThan(0.1)
  })

  it("Tech 3341 case 3: the relative gate drops the quiet -36 dBFS ends", () => {
    const s = join(sine(10, -36), sine(60, -23), sine(10, -36))
    expect(Math.abs(measureLoudness([s, s], 48_000).integratedLufs - -23)).toBeLessThan(0.1)
  })

  it("Tech 3341 case 4: the absolute gate drops the -72 dBFS ends", () => {
    const s = join(sine(10, -72), sine(10, -36), sine(60, -23), sine(10, -36), sine(10, -72))
    expect(Math.abs(measureLoudness([s, s], 48_000).integratedLufs - -23)).toBeLessThan(0.1)
  })

  it("Tech 3341 case 5: -26, -20, -26 dBFS averages to -23 LUFS", () => {
    const s = join(sine(20, -26), sine(20.1, -20), sine(20, -26))
    expect(Math.abs(measureLoudness([s, s], 48_000).integratedLufs - -23)).toBeLessThan(0.1)
  })

  it("re-derives the filters for other rates: 44.1 kHz and 24 kHz read the same", () => {
    const at = (rate: number) => measureLoudness([sine(10, -20, rate)], rate).integratedLufs
    const ref = at(48_000)
    expect(Math.abs(at(44_100) - ref)).toBeLessThan(0.1)
    expect(Math.abs(at(24_000) - ref)).toBeLessThan(0.1)
    expect(Math.abs(at(16_000) - ref)).toBeLessThan(0.2)
  })

  it("weights frequencies as K-weighting does: 100 Hz reads lower than 1 kHz, 4 kHz higher", () => {
    const at = (hz: number) => measureLoudness([sine(10, -20, 48_000, hz)], 48_000).integratedLufs
    const k1 = at(1000)
    // The high-pass takes ~0.5 dB off 100 Hz relative to 1 kHz (-0.69 dB
    // to -1.2 dB below the 1 kHz reading); the shelf adds ~+3.3 dB at 4 kHz.
    expect(at(100)).toBeLessThan(k1 - 0.3)
    expect(at(4000)).toBeGreaterThan(k1 + 2.5)
  })

  it("a quieter take reads quieter by exactly the difference", () => {
    const a = measureLoudness([sine(10, -12)], 48_000).integratedLufs
    const b = measureLoudness([sine(10, -30)], 48_000).integratedLufs
    expect(a - b).toBeCloseTo(18, 1)
  })

  it("has no loudness for silence, or for audio under the absolute gate", () => {
    expect(measureLoudness([new Float32Array(48_000 * 5)], 48_000).integratedLufs).toBe(SILENT_LUFS)
    expect(measureLoudness([sine(5, -80)], 48_000).integratedLufs).toBe(SILENT_LUFS)
  })

  // Review S5: a one-word line ("No.") is shorter than one 400 ms block. It
  // is measured as ONE block over the whole take, gated by the -70 only.
  it("measures a take shorter than one 400 ms block as one block over all of it", () => {
    const short = measureLoudness([sine(0.35, -20, 48_000, 300)], 48_000).integratedLufs
    const long = measureLoudness([sine(5, -20, 48_000, 300)], 48_000).integratedLufs
    expect(Math.abs(short - long)).toBeLessThan(0.5)
    expect(measureLoudness([sine(0.3, -80)], 48_000).integratedLufs).toBe(SILENT_LUFS)
    expect(measureLoudness([new Float32Array(0)], 48_000).integratedLufs).toBe(SILENT_LUFS)
  })
})

describe("true peak", () => {
  it("finds the peak between samples (4x oversampled)", () => {
    // A sine at a quarter of the rate, 45 degrees out: every sample lands at
    // 0.707 of the crest, so the sample peak is 3 dB under the true one.
    const s = sine(1, -6, 48_000, 12_000, Math.PI / 4)
    const r = measureLoudness([s], 48_000)
    expect(r.samplePeakDb).toBeCloseTo(-9.01, 1)
    expect(Math.abs(r.truePeakDb - -6)).toBeLessThan(0.3)
  })

  it("is the sample peak for an ordinary low sine", () => {
    const r = measureLoudness([sine(1, -10, 48_000, 440)], 48_000)
    expect(Math.abs(r.truePeakDb - -10)).toBeLessThan(0.05)
  })

  it("has a floor for silence instead of -Infinity, so it can be stored", () => {
    const r = measureLoudness([new Float32Array(4800)], 48_000)
    expect(Number.isFinite(r.truePeakDb)).toBe(true)
    expect(r.truePeakDb).toBeLessThan(-100)
  })
})
