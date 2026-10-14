// Timeline Part B — silence-based speech segmentation.
//
// Pure, deterministic core: given mono PCM samples, return the time ranges
// (ms) that contain speech, split at silent gaps. The audio-import path uses
// this to turn one imported clip into N media segments (one per spoken line)
// instead of a single whole-file segment. No fake timing — boundaries come
// from real signal energy; callers fall back to a single whole-file segment
// when this returns ≤1 region.
//
// AQU-1857: the detector is split in two so a caller never has to hold the
// whole decoded clip. `createRmsEnvelope` folds samples into one RMS value per
// analysis window as they arrive — the only thing the segmentation actually
// reads — so a 100-minute recording can be decoded a minute at a time and each
// minute's PCM released immediately. `detectSpeechSegments` is now a thin
// wrapper over that pair, so the whole-array path is unchanged by
// construction: feeding one chunk of N samples and feeding the same N samples
// in pieces accumulate the same per-window sums in the same order.

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

/** Default analysis window, exported so a streaming caller builds an envelope
 *  with the same geometry the detector's own defaults assume. */
export const DEFAULT_WINDOW_MS = DEFAULTS.windowMs

/**
 * One RMS amplitude per analysis window, plus the geometry needed to turn
 * window indices back into milliseconds. This is the entire input the
 * segmentation needs — orders of magnitude smaller than the PCM it came from
 * (one float per 20 ms instead of per sample).
 */
export interface RmsEnvelope {
  /** RMS amplitude (0..1) per window, in order. */
  rms: number[]
  /** Length of one full window in ms. */
  winMs: number
  /** Total length of the signal folded in, in ms. */
  totalMs: number
}

/** Folds PCM into an {@link RmsEnvelope} incrementally. */
export interface RmsEnvelopeAccumulator {
  /** Fold the next contiguous run of mono samples. */
  push(samples: Float32Array | readonly number[]): void
  /** Close the (possibly partial) final window and return the envelope.
   *  Idempotent — repeated calls return the same envelope. */
  finish(): RmsEnvelope
}

/**
 * Start an RMS envelope for a mono signal at `sampleRate`.
 *
 * Windows are taken from sample 0 in fixed strides, and a partial final window
 * still contributes its own RMS — the same geometry the whole-array detector
 * has always used. A window that straddles two `push` calls carries its
 * running sum across, so chunk boundaries are invisible to the result.
 */
export function createRmsEnvelope(
  sampleRate: number,
  windowMs: number = DEFAULTS.windowMs,
): RmsEnvelopeAccumulator {
  const win = Math.max(1, Math.round((windowMs / 1000) * sampleRate))
  const winMs = sampleRate > 0 ? (win / sampleRate) * 1000 : 0
  const rms: number[] = []
  let sum = 0
  let n = 0
  let samples = 0
  let closed = false

  return {
    push(chunk) {
      if (closed) throw new Error("RmsEnvelopeAccumulator: push after finish")
      const len = chunk.length
      for (let i = 0; i < len; i++) {
        const s = chunk[i]
        sum += s * s
        n++
        if (n === win) {
          rms.push(Math.sqrt(sum / n))
          sum = 0
          n = 0
        }
      }
      samples += len
    },
    finish() {
      if (!closed) {
        closed = true
        if (n > 0) rms.push(Math.sqrt(sum / n))
      }
      return { rms, winMs, totalMs: sampleRate > 0 ? (samples / sampleRate) * 1000 : 0 }
    },
  }
}

/**
 * Turn an RMS envelope into speech segments. Returns non-overlapping,
 * ascending `{ startMs, endMs }` ranges. Empty when the signal is all silence
 * (or empty); a single range spanning the energy when it's continuous speech.
 */
export function detectSpeechSegmentsFromEnvelope(
  envelope: RmsEnvelope,
  opts: SilenceSplitOptions = {},
): SpeechSegment[] {
  const o = { ...DEFAULTS, ...opts }
  const { rms, winMs, totalMs } = envelope
  if (rms.length === 0 || winMs <= 0) return []

  // 1. Collect contiguous voiced runs as [startWin, endWinExclusive).
  const runs: { s: number; e: number }[] = []
  let cur: { s: number; e: number } | null = null
  for (let k = 0; k < rms.length; k++) {
    if (rms[k] >= o.noiseFloorRms) {
      if (!cur) cur = { s: k, e: k + 1 }
      else cur.e = k + 1
    } else if (cur) {
      runs.push(cur)
      cur = null
    }
  }
  if (cur) runs.push(cur)
  if (runs.length === 0) return []

  // 2. Merge runs separated by a silent gap shorter than minSilenceMs.
  const merged: { s: number; e: number }[] = [runs[0]]
  for (let k = 1; k < runs.length; k++) {
    const prev = merged[merged.length - 1]
    const gapMs = (runs[k].s - prev.e) * winMs
    if (gapMs < o.minSilenceMs) prev.e = runs[k].e
    else merged.push(runs[k])
  }

  // 3. Window indices → padded, clamped ms; drop sub-minimum segments.
  const out: SpeechSegment[] = []
  for (const r of merged) {
    const startMs = Math.max(0, r.s * winMs - o.padMs)
    const endMs = Math.min(totalMs, r.e * winMs + o.padMs)
    if (endMs - startMs >= o.minSegmentMs) {
      out.push({ startMs: Math.round(startMs), endMs: Math.round(endMs) })
    }
  }

  // 4. Padding can make neighbours touch/overlap — clamp to keep them disjoint.
  for (let k = 1; k < out.length; k++) {
    if (out[k].startMs < out[k - 1].endMs) out[k - 1].endMs = out[k].startMs
  }
  return out
}

/**
 * Detect speech segments in a mono PCM channel held whole in memory.
 *
 * Convenience over {@link createRmsEnvelope} +
 * {@link detectSpeechSegmentsFromEnvelope} for callers small enough not to
 * care (recorded takes, test fixtures). Large imports stream instead — see
 * `src/lib/audio/speech-analysis.ts`.
 */
export function detectSpeechSegments(
  channel: Float32Array | readonly number[],
  sampleRate: number,
  opts: SilenceSplitOptions = {},
): SpeechSegment[] {
  if (channel.length === 0 || sampleRate <= 0) return []
  const o = { ...DEFAULTS, ...opts }
  const acc = createRmsEnvelope(sampleRate, o.windowMs)
  acc.push(channel)
  return detectSpeechSegmentsFromEnvelope(acc.finish(), opts)
}
