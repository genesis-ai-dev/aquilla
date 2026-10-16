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

/** AQU-1767: one part of a window to keep, in seconds from the window's start. */
export interface KeepSpan {
  startSec: number
  /** Infinity = to the window's end. */
  endSec: number
}

/**
 * AQU-1767 (Sam, 2026-10-14): a split take is transcribed WHOLE — every piece,
 * together — and only what its pieces keep: a gap between two pieces (a
 * trimmed breath, a deleted middle piece) is not part of the take. This joins
 * the kept spans of a window into one buffer, and maps a time in that buffer
 * back to the window, so the word times still land on the recording's clock.
 *
 * Spans are clamped to the buffer, sorted and merged. With nothing to drop
 * (no spans, or one covering it all) the buffer comes back as it was.
 */
export function keepSpans(
  pcm: Float32Array,
  spans: readonly KeepSpan[] | undefined,
  sampleRate: number,
): { pcm: Float32Array; toWindowSec: (sec: number) => number } {
  const same = { pcm, toWindowSec: (sec: number) => sec }
  if (!spans || spans.length === 0) return same
  const at = (sec: number) => Math.max(0, Math.min(pcm.length, Math.round(sec * sampleRate)))
  const segs = spans
    .map((s) => [at(s.startSec), Number.isFinite(s.endSec) ? at(s.endSec) : pcm.length] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  const merged: [number, number][] = []
  for (const [a, b] of segs) {
    const last = merged[merged.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  if (merged.length === 0) return same
  if (merged.length === 1 && merged[0][0] === 0 && merged[0][1] === pcm.length) return same
  const total = merged.reduce((n, [a, b]) => n + (b - a), 0)
  const out = new Float32Array(total)
  const joinedAt: number[] = []
  let o = 0
  for (const [a, b] of merged) {
    joinedAt.push(o)
    out.set(pcm.subarray(a, b), o)
    o += b - a
  }
  const toWindowSec = (sec: number) => {
    const s = sec * sampleRate
    let k = 0
    while (k + 1 < merged.length && s >= joinedAt[k + 1]) k++
    return (merged[k][0] + (s - joinedAt[k])) / sampleRate
  }
  return { pcm: out, toWindowSec }
}
