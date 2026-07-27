// AQU-646: turn detected speech ranges into an exhaustive partition of the
// clip — "cuts, not deletions". Speech detection (silence-split) and speaker
// turns (diarization) leave the audio BETWEEN their ranges owned by nothing,
// and the play-queue only plays each cell's window, so gap audio was silently
// skipped during playback. Tiling extends each range's END to the next range's
// START (trailing silence belongs to the preceding line — subtitle convention;
// the speech-onset start stays the anchor), pulls the first start to 0, and
// pushes the last end to the clip end.
//
// Timing vs trim: tiled ranges become CELL TIMING (startMs/endMs — what
// playback windows on). The tight detected boundaries stay as the attachment
// TRIMS (trimStartMs/trimEndMs — what Whisper transcription and voice-clone
// reference extraction slice), so transcripts don't fill with silence and a
// diarized speaker's clone reference can never absorb a neighbor's audio.

export interface TimedRange {
  startMs: number
  endMs: number
}

/**
 * Extend sorted-ascending ranges to cover `[0, totalMs]` with no gaps:
 * `start_0 → 0`, `end_i → max(end_i, start_{i+1})`, and
 * `end_last → max(end_last, round(totalMs))`. Returns a NEW array parallel to
 * the input (same length/order); overlapping inputs are preserved (ends never
 * shrink). Empty in → empty out. When `totalMs` is undefined (unknown clip
 * length) the last end stays tight.
 */
export function tileSegments(ranges: readonly TimedRange[], totalMs?: number): TimedRange[] {
  if (ranges.length === 0) return []
  return ranges.map((r, i) => {
    const startMs = i === 0 ? 0 : r.startMs
    const endMs =
      i < ranges.length - 1
        ? Math.max(r.endMs, ranges[i + 1].startMs)
        : totalMs !== undefined
          ? Math.max(r.endMs, Math.round(totalMs))
          : r.endMs
    return { startMs, endMs }
  })
}
