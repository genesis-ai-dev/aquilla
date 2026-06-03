// Timeline Part B — diarization helpers (pure core).
//
// The heavy lifting (sherpa-onnx WASM) lives in a Web Worker; these are the
// pure, testable pieces around it: resampling decoded audio to the 16 kHz mono
// the model needs, and turning the model's speaker "turns" into media-segment
// specs + the distinct speaker set for cast creation. No DOM, no wasm here.

/** Target sample rate sherpa-onnx speaker diarization expects. */
export const DIARIZATION_SAMPLE_RATE = 16000

/** One speaker turn from the diarizer, in milliseconds. (The wasm API returns
 *  seconds + an integer speaker index; the worker converts to this shape.) */
export interface DiarizationTurn {
  startMs: number
  endMs: number
  /** Cluster index assigned by the diarizer (0..N-1). Stable within one run. */
  speaker: number
}

/** A media segment derived from a turn: timing + the trim window into the
 *  single shared clip + which speaker cluster it belongs to. */
export interface DiarizedSegment {
  startMs: number
  endMs: number
  trimStartMs: number
  trimEndMs: number
  speaker: number
}

/**
 * Resample a mono Float32 channel to 16 kHz via linear interpolation. Returns
 * the input unchanged when it's already 16 kHz. Empty in → empty out. Pure.
 */
export function resampleToMono16k(channel: Float32Array, sampleRate: number): Float32Array {
  if (channel.length === 0 || sampleRate <= 0) return new Float32Array(0)
  if (sampleRate === DIARIZATION_SAMPLE_RATE) return channel

  const ratio = DIARIZATION_SAMPLE_RATE / sampleRate
  const outLen = Math.max(1, Math.round(channel.length * ratio))
  const out = new Float32Array(outLen)
  const step = sampleRate / DIARIZATION_SAMPLE_RATE // source samples per output sample
  for (let i = 0; i < outLen; i++) {
    const src = i * step
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, channel.length - 1)
    const frac = src - i0
    out[i] = channel[i0] * (1 - frac) + channel[i1] * frac
  }
  return out
}

/**
 * Convert diarizer turns into media-segment specs (one per turn) plus the
 * ascending list of distinct speaker indices (for cast creation). Turns are
 * sorted by start; zero/negative-length turns are dropped. Pure.
 */
export function turnsToSegments(turns: readonly DiarizationTurn[]): {
  segments: DiarizedSegment[]
  speakers: number[]
} {
  const valid = turns
    .filter((t) => Number.isFinite(t.startMs) && Number.isFinite(t.endMs) && t.endMs > t.startMs)
    .slice()
    .sort((a, b) => a.startMs - b.startMs)

  const segments: DiarizedSegment[] = valid.map((t) => ({
    startMs: Math.round(t.startMs),
    endMs: Math.round(t.endMs),
    trimStartMs: Math.round(t.startMs),
    trimEndMs: Math.round(t.endMs),
    speaker: t.speaker,
  }))

  const speakers = [...new Set(valid.map((t) => t.speaker))].sort((a, b) => a - b)
  return { segments, speakers }
}

/** Human label for a speaker cluster index (0-based → "Speaker 1"). */
export function speakerLabel(index: number): string {
  return `Speaker ${index + 1}`
}
