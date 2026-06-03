// Timeline Part B — silence-based speech segmentation.
//
// Pure, deterministic core: given mono PCM samples, return the time ranges
// (ms) that contain speech, split at silent gaps. The audio-import path uses
// this to turn one imported clip into N media segments (one per spoken line)
// instead of a single whole-file segment. No fake timing — boundaries come
// from real signal energy; callers fall back to a single whole-file segment
// when this returns ≤1 region.

export interface SilenceSplitOptions {
  /** Analysis window length in ms (RMS computed per window). */
  windowMs?: number
  /** RMS amplitude (0..1) at/above which a window counts as speech. */
  noiseFloorRms?: number
  /** Silent gaps shorter than this do NOT split a segment (ms). */
  minSilenceMs?: number
  /** Segments shorter than this are dropped (ms). */
  minSegmentMs?: number
  /** Pad each detected segment edge outward by this much (ms). */
  padMs?: number
}

export interface SpeechSegment {
  startMs: number
  endMs: number
}

const DEFAULTS: Required<SilenceSplitOptions> = {
  windowMs: 20,
  noiseFloorRms: 0.02,
  minSilenceMs: 300,
  minSegmentMs: 200,
  padMs: 50,
}

/**
 * Detect speech segments in a mono PCM channel. Returns non-overlapping,
 * ascending `{ startMs, endMs }` ranges. Empty when the signal is all silence
 * (or empty); a single range spanning the energy when it's continuous speech.
 */
export function detectSpeechSegments(
  channel: Float32Array | readonly number[],
  sampleRate: number,
  opts: SilenceSplitOptions = {},
): SpeechSegment[] {
  const o = { ...DEFAULTS, ...opts }
  const len = channel.length
  if (len === 0 || sampleRate <= 0) return []

  const win = Math.max(1, Math.round((o.windowMs / 1000) * sampleRate))
  const winMs = (win / sampleRate) * 1000
  const totalMs = (len / sampleRate) * 1000

  // 1. Per-window voiced/silent classification via RMS.
  const voiced: boolean[] = []
  for (let i = 0; i < len; i += win) {
    let sum = 0
    let n = 0
    const end = Math.min(i + win, len)
    for (let j = i; j < end; j++) {
      const s = channel[j]
      sum += s * s
      n++
    }
    const rms = n ? Math.sqrt(sum / n) : 0
    voiced.push(rms >= o.noiseFloorRms)
  }

  // 2. Collect contiguous voiced runs as [startWin, endWinExclusive).
  const runs: { s: number; e: number }[] = []
  let cur: { s: number; e: number } | null = null
  for (let k = 0; k < voiced.length; k++) {
    if (voiced[k]) {
      if (!cur) cur = { s: k, e: k + 1 }
      else cur.e = k + 1
    } else if (cur) {
      runs.push(cur)
      cur = null
    }
  }
  if (cur) runs.push(cur)
  if (runs.length === 0) return []

  // 3. Merge runs separated by a silent gap shorter than minSilenceMs.
  const merged: { s: number; e: number }[] = [runs[0]]
  for (let k = 1; k < runs.length; k++) {
    const prev = merged[merged.length - 1]
    const gapMs = (runs[k].s - prev.e) * winMs
    if (gapMs < o.minSilenceMs) prev.e = runs[k].e
    else merged.push(runs[k])
  }

  // 4. Window indices → padded, clamped ms; drop sub-minimum segments.
  const out: SpeechSegment[] = []
  for (const r of merged) {
    const startMs = Math.max(0, r.s * winMs - o.padMs)
    const endMs = Math.min(totalMs, r.e * winMs + o.padMs)
    if (endMs - startMs >= o.minSegmentMs) {
      out.push({ startMs: Math.round(startMs), endMs: Math.round(endMs) })
    }
  }

  // 5. Padding can make neighbours touch/overlap — clamp to keep them disjoint.
  for (let k = 1; k < out.length; k++) {
    if (out[k].startMs < out[k - 1].endMs) out[k - 1].endMs = out[k].startMs
  }
  return out
}
