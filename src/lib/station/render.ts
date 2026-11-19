// Samples for the Station (AQU-2327): the edited recording as one buffer, the
// clip's own volume and fades applied to it, and the peaks that draw it.
// Every source is mono at the same rate (the app decodes everything to
// 48 kHz mono, decode-mono.ts), so a segment is a plain copy.

import { clipDb, dbToGain, gainAt, type ClipMix, type PlacedSegment } from "./edit-list"

export interface PcmSource {
  data: Float32Array
  rate: number
}

export type PcmLookup = (src: string) => PcmSource | null | undefined

/** The edited recording, untrimmed and at its own level: what a saved
 *  version holds (the trim, fades and volume stay on the clip). */
export function renderSegments(placed: readonly PlacedSegment[], lookup: PcmLookup, rate: number): Float32Array {
  const total = Math.round((placed.at(-1)?.t1 ?? 0) * rate)
  const out = new Float32Array(Math.max(0, total))
  for (const g of placed) {
    const s = lookup(g.src)
    if (!s) continue
    const from = Math.max(0, Math.round(g.a * s.rate))
    const to = Math.min(s.data.length, Math.round(g.b * s.rate))
    const at = Math.round(g.t0 * rate)
    if (to > from && at < out.length) out.set(s.data.subarray(from, Math.min(to, from + (out.length - at))), at)
  }
  return out
}

/** The clip's volume and fades over its kept part, and that part alone. */
export function applyClipMix(samples: Float32Array, rate: number, clip: ClipMix): Float32Array {
  const a = Math.max(0, Math.min(samples.length, Math.round(clip.trimA * rate)))
  const b = Math.max(a, Math.min(samples.length, Math.round(clip.trimB * rate)))
  const out = samples.slice(a, b)
  const flat = clip.fadeIn <= 0 && clip.fadeOut <= 0 && !clipDb(clip)
  if (flat) return out
  for (let i = 0; i < out.length; i++) out[i] *= gainAt((a + i) / rate, clip)
  return out
}

/**
 * The whole recording as the clip plays it (the Station's preview): its
 * volume everywhere, and the fades inside the kept part. A selection outside
 * the kept part still plays, at the clip's volume.
 */
export function mixWhole(samples: Float32Array, rate: number, clip: ClipMix): Float32Array {
  const flat = clip.fadeIn <= 0 && clip.fadeOut <= 0 && !clipDb(clip)
  if (flat) return samples
  const out = new Float32Array(samples.length)
  const g0 = Math.pow(10, clipDb(clip) / 20)
  const a = Math.round(clip.trimA * rate)
  const b = Math.round(clip.trimB * rate)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * (i >= a && i <= b ? gainAt(i / rate, clip) : g0)
  return out
}

/** The loudest sample, for drawing every view against the same scale. */
export function peakOf(data: Float32Array): number {
  let m = 0
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(data[i])
    if (v > m) m = v
  }
  return m
}

/** The lowest a recording's loudest moment is drawn, as a share of the lane,
 *  so a quiet take that isn't raised still reads as a waveform (the timeline
 *  clip's floor, take-gain `waveLevelScale`). */
export const STATION_WAVE_FLOOR = 0.12
/** Headroom over full scale: a waveform played at 0 dBFS stops just short of
 *  the lane's edges. */
const HEADROOM = 1.05

/**
 * `n` columns of peaks over [va, vb] of the edited recording, drawn at the
 * level it PLAYS against a fixed headroom (full scale), as board 72 draws it
 * (evidence 72D/E/G): the recording's loudest moment sits at its played peak —
 * the clip's volume with evening out — so a raised take is taller and an
 * evened one is never clipped into a block, however far it was raised. Below
 * STATION_WAVE_FLOOR it is held at the floor, so it stays readable. The fades
 * shape the kept part (40b: shown live). Long slices are read with a stride,
 * so a zoomed-out hour stays cheap.
 *
 * `peak` is the recording's loudest sample (peakOf).
 */
export function viewPeaks(
  placed: readonly PlacedSegment[],
  lookup: PcmLookup,
  va: number,
  vb: number,
  n: number,
  peak: number,
  clip?: ClipMix,
): Float32Array {
  const out = new Float32Array(Math.max(0, n))
  const span = Math.max(1e-6, vb - va)
  // The clip's gain where it is flat (volume + evening), and the height its
  // loudest moment is drawn at: its played peak, held between the floor and
  // full scale.
  const gPlay = clip ? dbToGain(clipDb(clip)) : 1
  const played = Math.min(1, Math.max(STATION_WAVE_FLOOR, peak * gPlay))
  const scale = peak > 0 ? played / (peak * HEADROOM) : 1
  for (let i = 0; i < n; i++) {
    const c0 = va + (span * i) / n
    const c1 = va + (span * (i + 1)) / n
    let m = 0
    for (const g of placed) {
      if (g.t1 <= c0 || g.t0 >= c1) continue
      const s = lookup(g.src)
      if (!s) continue
      const from = g.a + Math.max(0, c0 - g.t0)
      const to = g.a + Math.min(g.b - g.a, c1 - g.t0)
      const i0 = Math.max(0, Math.floor(from * s.rate))
      const i1 = Math.min(s.data.length, Math.ceil(to * s.rate))
      const stride = Math.max(1, Math.floor((i1 - i0) / 4096))
      for (let k = i0; k < i1; k += stride) {
        const v = Math.abs(s.data[k])
        if (v > m) m = v
      }
    }
    const t = (c0 + c1) / 2
    // The fades (and anything else under the flat gain) as a share of it.
    const shape = !clip || gPlay <= 0 ? 1 : (t >= clip.trimA && t <= clip.trimB ? gainAt(t, clip) : gPlay) / gPlay
    out[i] = Math.min(1, m * scale * shape)
  }
  return out
}
