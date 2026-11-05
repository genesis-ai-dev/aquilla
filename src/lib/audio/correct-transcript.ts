/**
 * Remap a corrected transcript onto existing word timings.
 *
 * Oral transcripts are a reading of the recording — users must be able to
 * fix Whisper mistakes without throwing the karaoke timestamps away. Same
 * word count keeps each word's audio span and, by default, the character
 * offsets already stored (they address the cell, whose own text this
 * correction does not touch). Replacing those offsets with the corrected
 * string's layout makes a longer word look like the cell was shortened, and
 * the preview asks for a fresh transcription. A different word count
 * redistributes the original time range across the new words and reindexes
 * character offsets into the corrected transcript.
 *
 * AQU-2254 — `reindexOffsets` is for the other case: a save that also makes
 * `correctedText` the cell's own text (a source segment's `transcription`, so
 * an AI cleanup of a transcription-mode cell). There the pre-correction
 * offsets describe wording that no longer exists, and keeping them walks the
 * karaoke highlight off its words as soon as one correction changes a word's
 * length. Each word keeps its audio span and takes its position in the text
 * the cell is about to hold, so the highlight stays on the word being spoken.
 */

import type { WordTiming } from "@/lib/codex-editor/types"
import { tokenizeWords } from "./timings"

export interface RemapTranscriptOptions {
  /**
   * True when `correctedText` becomes the text the timings address — the
   * caller is writing it onto the cell in the same save. Character offsets are
   * then taken from `correctedText` instead of being carried over.
   */
  reindexOffsets?: boolean
}

export function remapTranscriptTimings(
  timings: WordTiming[],
  correctedText: string,
  opts: RemapTranscriptOptions = {},
): WordTiming[] {
  const words = tokenizeWords(correctedText)
  if (words.length === 0) return []

  if (timings.length === words.length) {
    return words.map((w, i) => ({
      word: w.word,
      start: opts.reindexOffsets ? w.start : timings[i].start,
      end: opts.reindexOffsets ? w.end : timings[i].end,
      t0: timings[i].t0,
      t1: timings[i].t1,
    }))
  }

  const tStart = timings[0]?.t0 ?? 0
  const tEnd = timings[timings.length - 1]?.t1 ?? tStart
  const span = Math.max(tEnd - tStart, 0)
  const slice = words.length > 0 ? span / words.length : 0
  return words.map((w, i) => ({
    word: w.word,
    start: w.start,
    end: w.end,
    t0: tStart + i * slice,
    t1: tStart + (i + 1) * slice,
  }))
}
