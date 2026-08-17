// AQU-929: sample-window math for trimming a clip down to one segment.
//
// Kept pure (and free of Web Audio) so the memory-bounding decode path in
// transcribe.ts can be unit-tested — the decode itself is browser-only, but the
// arithmetic that decides *how little* audio we materialise is the part that
// bounds peak memory, so it gets to be testable.

/** AQU-646: a trim window (ms) selecting one segment of a shared clip. */
export interface PcmTrimWindow {
  trimStartMs?: number | null
  trimEndMs?: number | null
}

export interface SampleWindow {
  /** First sample index of the window (inclusive). */
  start: number
  /** One past the last sample index of the window. */
  end: number
  /** Number of samples in the window. */
  length: number
  /** True when the window covers the whole clip (no trimming to do). */
  isFull: boolean
}

/**
 * Resolve a trim window (ms) against a clip of `totalSamples` at `sampleRate`.
 *
 * Out-of-range/absent edges clamp to the clip bounds; an inverted or empty
 * window falls back to the full clip (defensive — better a long transcript than
 * none, matching the pre-AQU-929 behaviour of `slicePcmToTrim`).
 */
export function resolvePcmWindow(
  totalSamples: number,
  sampleRate: number,
  trim?: PcmTrimWindow,
): SampleWindow {
  const full: SampleWindow = { start: 0, end: totalSamples, length: totalSamples, isFull: true }
  const startMs = trim?.trimStartMs ?? null
  const endMs = trim?.trimEndMs ?? null
  if (startMs == null && endMs == null) return full

  const clamp = (ms: number) =>
    Math.max(0, Math.min(totalSamples, Math.round((ms / 1000) * sampleRate)))
  const start = clamp(startMs ?? 0)
  const end = endMs == null ? totalSamples : clamp(endMs)
  if (end <= start) return full
  if (start === 0 && end === totalSamples) return full
  return { start, end, length: end - start, isFull: false }
}
