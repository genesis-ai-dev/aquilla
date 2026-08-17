/**
 * Remap a corrected transcript onto existing word timings.
 *
 * Oral transcripts are a reading of the recording — users must be able to
 * fix Whisper mistakes without throwing the karaoke timestamps away. Same
 * word count keeps each word's audio span; a different count redistributes
 * the original time range across the new words and reindexes character
 * offsets into the corrected transcript.
 */

import type { WordTiming } from "@/lib/codex-editor/types"
import { tokenizeWords } from "./timings"

export function remapTranscriptTimings(
  timings: WordTiming[],
  correctedText: string,
): WordTiming[] {
  const words = tokenizeWords(correctedText)
  if (words.length === 0) return []

  if (timings.length === words.length) {
    return words.map((w, i) => ({
      word: w.word,
      start: w.start,
      end: w.end,
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
