// How a take's transcript compares with the line's text — one answer for the
// transcript card and for the short verdict beside every take in the Recording
// tab (2026-09-29), so the two can never disagree.

import { tokenizeWords } from "@/lib/audio/timings"

export type TranscriptVerdict =
  /** Never transcribed. */
  | { kind: "none" }
  /** The words heard are the words written (case and punctuation aside). */
  | { kind: "match" }
  /** They differ, by this many words: added, dropped or changed. */
  | { kind: "differs"; words: number }
  /** Transcribed against text that has since been shortened — the same
   *  words up to the cut, its word positions running past the text's end —
   *  so it needs transcribing again. */
  | { kind: "stale" }

/** Lower-case words with punctuation dropped — the transcript card's
 *  long-standing "loosely equal" rule, as a word list. */
export function looseWords(text: string): string[] {
  const norm = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim().replace(/\s+/g, " ")
  return norm ? norm.split(" ") : []
}

/** Words to add, drop or change to turn one list into the other. */
export function wordDifferences(a: readonly string[], b: readonly string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

export function transcriptVerdict({
  timings,
  cellText,
  alignedToCellText,
}: {
  timings: ReadonlyArray<{ word: string; end: number }> | null | undefined
  cellText: string
  /** Whether the timings' offsets point into the cell text (the heard words
   *  matched its word count). Worked out from the two when not given. */
  alignedToCellText?: boolean
}): TranscriptVerdict {
  if (!timings || timings.length === 0) return { kind: "none" }
  const transcript = timings.map((t) => t.word).join(" ")
  const words = wordDifferences(looseWords(transcript), looseWords(cellText))
  if (words === 0) return { kind: "match" }
  // "Stale" only when the cell lost the tail of the text these offsets were
  // aligned to: a shortened cell, the same words up to the cut (AQU-1211). A
  // corrected transcript can run past the cell without anyone shortening it —
  // that is a wording difference, not a reason to transcribe again.
  const aligned = alignedToCellText ?? tokenizeWords(cellText).length === timings.length
  const lostTheTail = aligned && timings[timings.length - 1].end > cellText.length && transcript.startsWith(cellText)
  return lostTheTail ? { kind: "stale" } : { kind: "differs", words }
}
