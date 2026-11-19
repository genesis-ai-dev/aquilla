// AQU-2664: a take's loudness, measured the way broadcast meters do it
// (ITU-R BS.1770-5, the meter EBU R128 and every loudness target is defined
// against), plus its true peak, so "even out" can set every take to one level
// without raising any of them into distortion.
//
// INTEGRATED LOUDNESS (LUFS):
//   1. K-weighting: a high shelf (+4 dB above ~1.7 kHz, how the head hears)
//      and then a high-pass (RLB, ~38 Hz). BS.1770 publishes the coefficients
//      for 48 kHz only; for any other rate they are re-derived from the same
//      analogue filters (the libebur128 method), so 44.1, 24 and 16 kHz takes
//      read the same as at 48.
//   2. Mean square in 400 ms blocks, overlapping by 75% (a block every 100 ms).
//   3. Two gates: blocks under -70 LUFS (silence) are dropped, then blocks
//      more than 10 LU under the loudness of what is left (pauses, breaths).
//   4. The loudness of the blocks kept.
// Every channel has weight 1 (no surround here). A MONO take is measured as
// it will be heard, on both speakers: dual mono, its energy counted twice
// (+3 LU, BS.1770) — Sam, Nov 19 — so −16 means "−16 as heard" for mono and
// stereo alike, and a mono voice is not left 3 dB hot beside stereo music.
// A take shorter than one 400 ms block (a one-word line) is measured as ONE
// block over all of it, gated by the −70 only.
//
// TRUE PEAK (dBTP): the highest point of the waveform BETWEEN samples too, by
// 4x oversampling (a 48-tap windowed-sinc interpolator, as BS.1770 Annex 2
// describes). Only stretches near the sample peak are interpolated: a point
// between two samples can't sit far above both of them, so the rest can't
// hold the peak, and a long take is measured in a fraction of the time.
//
// Memory: one number per 100 ms per channel is kept, never a filtered copy of
// the audio, so the meter costs nothing beside the decoded samples.

/** The integrated loudness of a take with nothing above the -70 LUFS gate
 *  (silence, or shorter than one 400 ms block): there is nothing to measure,
 *  so nothing to even out. Stored as a number so "measured: silent" is not
 *  confused with "not measured yet" (NULL). */
export const SILENT_LUFS = -70

/** The true peak of digital silence, instead of -Infinity, so it can be stored. */
export const PEAK_FLOOR_DB = -144

export interface Biquad {
  b: [number, number, number]
  a: [1, number, number]
}

export interface LoudnessReading {
  /** Integrated loudness, LUFS; {@link SILENT_LUFS} when nothing passes the gate. */
  integratedLufs: number
  /** 4x oversampled true peak, dBTP (floored at {@link PEAK_FLOOR_DB}). */
  truePeakDb: number
  /** The highest sample, dBFS (floored the same way). */
  samplePeakDb: number
}

/** The K-weighting filter pair (shelf, then high-pass) for a sample rate. */
export function kWeighting(rate: number): { shelf: Biquad; highPass: Biquad } {
  // Stage 1, the high shelf. These analogue parameters reproduce BS.1770's
  // 48 kHz coefficients to ~1e-10 and give the same filter at any rate.
  let f0 = 1681.974450955533
  const G = 3.999843853973347
  let Q = 0.7071752369554196
  let K = Math.tan((Math.PI * f0) / rate)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  let a0 = 1 + K / Q + K * K
  const shelf: Biquad = {
    b: [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0],
    a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  }
  // Stage 2, the RLB high-pass. Its numerator is [1, -2, 1] at every rate
  // (BS.1770 table 2), with no gain term: the -0.691 below accounts for it.
  f0 = 38.13547087602444
  Q = 0.5003270373238773
  K = Math.tan((Math.PI * f0) / rate)
  a0 = 1 + K / Q + K * K
  const highPass: Biquad = { b: [1, -2, 1], a: [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0] }
  return { shelf, highPass }
}

const toDb = (amp: number) => (amp > 0 ? Math.max(PEAK_FLOOR_DB, 20 * Math.log10(amp)) : PEAK_FLOOR_DB)
const lufsOf = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare)

/** How many samples the meter works through between two chances to yield. */
export const METER_CHUNK = 48_000 // one second at 48 kHz

/**
 * The meter, as a generator that yields after about every {@link METER_CHUNK}
 * samples of work (AQU-2664, the weak-hardware rule). Run straight through
 * (`measureLoudness`, and the worker) it is one pass; run with pauses
 * (`measureLoudnessYielding`, the on-page fallback) it lets the editor paint
 * and type between chunks, inside a long take too. Either way the arithmetic
 * is the same code in the same order, so the readings are identical.
 */
export function* meterSteps(channels: readonly Float32Array[], rate: number, chunk = METER_CHUNK): Generator<void, LoudnessReading, void> {
  if (channels.length === 0) return { integratedLufs: SILENT_LUFS, truePeakDb: PEAK_FLOOR_DB, samplePeakDb: PEAK_FLOOR_DB }
  let budget = chunk
  // 1. Sample peaks, and the K-weighted energy per 100 ms step.
  const step = Math.round(rate / 10)
  const len = Math.min(...channels.map((c) => c.length))
  const steps = step > 0 ? Math.floor(len / step) : 0
  const { shelf: s, highPass: h } = kWeighting(rate)
  const samplePeaks: number[] = []
  const energies: Float64Array[] = []
  // Every K-weighted square, for a take shorter than one block.
  let total = 0
  for (const x of channels) {
    const e = new Float64Array(steps)
    // Direct form I, in doubles (the 38 Hz high-pass needs the precision).
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    let u1 = 0, u2 = 0, z1 = 0, z2 = 0
    const n = steps * step
    let peak = 0
    for (let i = 0; i < x.length; i++) {
      const xi = x[i]
      const a = Math.abs(xi)
      if (a > peak) peak = a
      if (i < len) {
        const y = s.b[0] * xi + s.b[1] * x1 + s.b[2] * x2 - s.a[1] * y1 - s.a[2] * y2
        x2 = x1; x1 = xi; y2 = y1; y1 = y
        const z = h.b[0] * y + h.b[1] * u1 + h.b[2] * u2 - h.a[1] * z1 - h.a[2] * z2
        u2 = u1; u1 = y; z2 = z1; z1 = z
        if (i < n) e[(i / step) | 0] += z * z
        total += z * z
      }
      if (--budget <= 0) {
        budget = chunk
        yield
      }
    }
    samplePeaks.push(peak)
    energies.push(e)
  }
  // 2. True peak: only pairs within 6 dB of the sample peak are interpolated
  //    (a point between two samples can't sit far above both of them).
  let sample = 0
  let truePeak = 0
  for (let c = 0; c < channels.length; c++) {
    const x = channels[c]
    const sp = samplePeaks[c]
    sample = Math.max(sample, sp)
    truePeak = Math.max(truePeak, sp)
    if (sp === 0) continue
    const near = sp * 0.5
    const n = x.length
    for (let i = 0; i < n - 1; i++) {
      if (--budget <= 0) {
        budget = chunk
        yield
      }
      if (Math.abs(x[i]) < near && Math.abs(x[i + 1]) < near) continue
      for (const taps of PHASES) {
        let y = 0
        for (let m = -HALF + 1; m <= HALF; m++) {
          const j = i + m
          if (j >= 0 && j < n) y += x[j] * taps[m + HALF - 1]
        }
        const a = Math.abs(y)
        if (a > truePeak) truePeak = a
      }
    }
  }
  // Dual mono: a mono take's energy counts on both speakers.
  const weight = channels.length === 1 ? 2 : 1
  const integratedLufs = steps >= 4 ? gated(energies, steps, step, weight) : shortTake(total * weight, len)
  return { integratedLufs, truePeakDb: toDb(truePeak), samplePeakDb: toDb(sample) }
}

/** A take shorter than one block: one block over all of it, the −70 gate only. */
function shortTake(energy: number, len: number): number {
  if (len <= 0 || !(energy > 0)) return SILENT_LUFS
  const l = lufsOf(energy / len)
  return l > SILENT_LUFS ? l : SILENT_LUFS
}

/** Integrated loudness from the step energies, BS.1770-5 gating. */
function gated(energies: readonly Float64Array[], steps: number, step: number, weight: number): number {
  const blocks = steps - 3 // 400 ms = four steps
  if (!(blocks > 0) || step <= 0) return SILENT_LUFS
  // Each block's mean square, summed over channels (all weight 1).
  const z = new Float64Array(blocks)
  const blockLen = step * 4
  for (const e of energies) {
    for (let j = 0; j < blocks; j++) z[j] += (weight * (e[j] + e[j + 1] + e[j + 2] + e[j + 3])) / blockLen
  }
  const ABS_GATE = SILENT_LUFS
  let sum = 0
  let count = 0
  for (let j = 0; j < blocks; j++) {
    if (z[j] > 0 && lufsOf(z[j]) > ABS_GATE) {
      sum += z[j]
      count++
    }
  }
  if (count === 0) return SILENT_LUFS
  const relGate = lufsOf(sum / count) - 10
  let kept = 0
  let keptCount = 0
  for (let j = 0; j < blocks; j++) {
    if (z[j] > 0) {
      const l = lufsOf(z[j])
      if (l > ABS_GATE && l > relGate) {
        kept += z[j]
        keptCount++
      }
    }
  }
  // keptCount >= 1: the loudest block always clears a gate 10 LU under the mean.
  return Math.max(SILENT_LUFS, lufsOf(kept / keptCount))
}

// The 4x interpolator: phases 1/4, 2/4, 3/4 between two samples, 12 taps each
// (48 taps in all), a Hann-windowed sinc normalised to unity gain per phase.
const HALF = 6
const PHASES: Float64Array[] = [1, 2, 3].map((k) => {
  const f = k / 4
  const taps = new Float64Array(2 * HALF)
  let sum = 0
  for (let m = -HALF + 1; m <= HALF; m++) {
    const t = f - m
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)
    const w = 0.5 * (1 + Math.cos((Math.PI * t) / (HALF + 1)))
    taps[m + HALF - 1] = sinc * w
    sum += sinc * w
  }
  for (let i = 0; i < taps.length; i++) taps[i] /= sum
  return taps
})

/**
 * Measure a take, straight through: its integrated loudness and its peaks.
 * `channels` are the decoded samples (one array per channel, or the app's
 * mono mix), at `rate`. Blocks its thread for the whole take — the worker's
 * path. On the page use `measureLoudnessYielding` (or loudness-client.ts).
 */
export function measureLoudness(channels: readonly Float32Array[], rate: number): LoudnessReading {
  const run = meterSteps(channels, rate, Number.MAX_SAFE_INTEGER)
  for (;;) {
    const r = run.next()
    if (r.done) return r.value
  }
}

/** Give the page a turn: a macrotask, so input and paint run in between. */
export const yieldToPage = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Measure a take on the page, yielding every `chunk` samples of work. */
export async function measureLoudnessYielding(
  channels: readonly Float32Array[],
  rate: number,
  opts: { chunk?: number; yieldFn?: () => Promise<void>; signal?: AbortSignal } = {},
): Promise<LoudnessReading> {
  const pause = opts.yieldFn ?? yieldToPage
  const run = meterSteps(channels, rate, opts.chunk ?? METER_CHUNK)
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException("loudness: aborted", "AbortError")
    const r = run.next()
    if (r.done) return r.value
    await pause()
  }
}
