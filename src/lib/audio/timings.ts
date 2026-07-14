// Word-level audio timing helpers. The read/write helpers that touched
// per-file Y.Doc handles were dropped in Phase 2c-γ; reattaching timings
// to D1 cells is deferred to its own event grammar. The pure helpers
// below are still in use by the karaoke renderer (TranslatedEditor) and
// the editor table (EditorTable) so they survive untouched.

import type { WordTiming } from "@/lib/codex-editor/types"

/**
 * Tokenize plain text into word spans. A "word" is any maximal run of
 * non-whitespace characters. Returns inclusive-start/exclusive-end offsets.
 */
export function tokenizeWords(text: string): Array<{ word: string; start: number; end: number }> {
  const out: Array<{ word: string; start: number; end: number }> = []
  let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (i >= text.length) break
    const start = i
    while (i < text.length && !/\s/.test(text[i])) i++
    out.push({ word: text.slice(start, i), start, end: i })
  }
  return out
}

/**
 * Spread a duration evenly across the words of `text`. Useful as a placeholder
 * before real ASR/alignment runs — the karaoke band will sweep through every
 * word but won't actually match the audio. Surface this clearly in the UI.
 */
export function uniformTimings(text: string, duration: number): WordTiming[] {
  const words = tokenizeWords(text)
  if (words.length === 0 || duration <= 0) return []
  const slice = duration / words.length
  return words.map((w, i) => ({
    word: w.word,
    start: w.start,
    end: w.end,
    t0: i * slice,
    t1: (i + 1) * slice,
  }))
}

/**
 * Convert Whisper chunks → WordTiming[]. When `cellText` is provided and the
 * chunks line up 1:1 with the cell's tokenized words, we emit timings indexed
 * against the cell text so the karaoke decoration paints the user's typed
 * words. Otherwise we index against the transcript itself (won't match cell
 * text, but the user can re-record to fix).
 */
export function alignChunks(
  chunks: Array<{ text: string; start: number; end: number }>,
  cellText: string | undefined,
): WordTiming[] {
  if (chunks.length === 0) return []

  if (cellText) {
    const cellWords = tokenizeWords(cellText)
    if (cellWords.length === chunks.length) {
      return cellWords.map((w, i) => ({
        word: w.word,
        start: w.start,
        end: w.end,
        t0: chunks[i].start,
        t1: chunks[i].end,
      }))
    }
  }

  // Fall back to indexing against the transcript text.
  const transcript = chunks.map((c) => c.text).join(" ")
  const transcriptWords = tokenizeWords(transcript)
  const out: WordTiming[] = []
  for (let i = 0; i < Math.min(transcriptWords.length, chunks.length); i++) {
    out.push({
      word: transcriptWords[i].word,
      start: transcriptWords[i].start,
      end: transcriptWords[i].end,
      t0: chunks[i].start,
      t1: chunks[i].end,
    })
  }
  return out
}

/**
 * Plain-text offset span [start, end) of the word active at time `t`, or null
 * if no word is active (or the span is empty). Used by the read-only "karaoke
 * while listening" renderer (KaraokeReadText) so the highlight follows playback
 * even when the cell is not being actively edited. The editor path uses
 * findActiveTimingIndex directly and paints via the ProseMirror plugin.
 */
export function activeWordRange(
  timings: WordTiming[] | undefined,
  t: number,
): { start: number; end: number } | null {
  const idx = findActiveTimingIndex(timings, t)
  if (idx < 0 || !timings) return null
  const w = timings[idx]
  if (w.end <= w.start) return null
  return { start: w.start, end: w.end }
}

/**
 * Find the index of the timing whose [t0, t1) contains `t`. Returns -1 if no
 * word is active at that time. O(log n) — assumes timings are sorted by t0
 * and non-overlapping (which both Whisper and forced aligners produce).
 */
export function findActiveTimingIndex(timings: WordTiming[] | undefined, t: number): number {
  if (!timings || timings.length === 0) return -1
  let lo = 0, hi = timings.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const w = timings[mid]
    if (t < w.t0) hi = mid - 1
    else if (t >= w.t1) lo = mid + 1
    else return mid
  }
  return -1
}
