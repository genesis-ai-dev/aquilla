import { v7 as uuidv7 } from "uuid"
import type { TranslatableString } from "../parsers/core-types"

export interface AlignmentWord {
  text: string
  start: number
  end: number
}

export interface AlignedScriptSegment {
  text: string
  start: number | null
  end: number | null
  /** Evidence score: word coverage or acoustic score, identified by method. */
  confidence: number
  matchedWords: number
  totalWords: number
  needsReview: boolean
  status: "matched" | "partial" | "unmatched" | "ambiguous"
}

export interface ScriptAlignmentResult {
  segments: readonly AlignedScriptSegment[]
  method?: "whisper-word-match" | "ctc-forced-alignment"
}

/** Expected evidence limits let callers choose acoustic alignment instead. */
export class WordAlignmentUnavailableError extends Error {}

/** Paragraphs define segments; preserve the supplied wording. */
export function alignScriptParagraphs(
  script: string,
  chunks: readonly AlignmentWord[],
): { segments: AlignedScriptSegment[] } {
  let previousStart = -1
  for (const chunk of chunks) {
    if (!Number.isFinite(chunk.start) || !Number.isFinite(chunk.end)
      || chunk.start < 0 || chunk.end <= chunk.start
      || chunk.start < previousStart) {
      throw new WordAlignmentUnavailableError("Invalid word timings")
    }
    previousStart = chunk.start
  }
  const tokenize = (text: string) =>
    (text.normalize("NFKC").toLowerCase()
      .match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [])
      .map(word => word.replace(/['’]/g, ""))
  const paragraphs = script.trim().split(/\r?\n\s*\r?\n/)
    .map(text => ({ text: text.trim(), words: tokenize(text) }))
    .filter(paragraph => paragraph.text.length > 0)
  const scriptWords = paragraphs.flatMap(paragraph => paragraph.words)
  const spokenWords = chunks.flatMap(chunk =>
    tokenize(chunk.text).map(word => ({ word, chunk })),
  )
  const width = spokenWords.length + 1
  // Bounded dynamic programming retains globally monotonic matches. Missing
  // wording never shifts later paragraphs onto unrelated audio.
  if ((scriptWords.length + 1) * width > 4_000_000) {
    throw new WordAlignmentUnavailableError("This script needs acoustic alignment or shorter sections.")
  }
  const scores = new Uint32Array((scriptWords.length + 1) * width)
  for (let i = scriptWords.length - 1; i >= 0; i--) {
    for (let j = spokenWords.length - 1; j >= 0; j--) {
      scores[i * width + j] = scriptWords[i] === spokenWords[j].word
        ? 1 + scores[(i + 1) * width + j + 1]
        : Math.max(scores[(i + 1) * width + j], scores[i * width + j + 1])
    }
  }
  const matches = new Map<number, AlignmentWord>()
  const ambiguous = new Set<number>()
  let i = 0
  let j = 0
  while (i < scriptWords.length && j < spokenWords.length) {
    if (scriptWords[i] === spokenWords[j].word) {
      if (scores[i * width + j + 1] === scores[i * width + j]) {
        ambiguous.add(i)
      }
      matches.set(i++, spokenWords[j++].chunk)
    } else if (scores[(i + 1) * width + j] > scores[i * width + j + 1]) {
      i++
    } else j++
  }
  let offset = 0
  const segments: AlignedScriptSegment[] = paragraphs.map(({ text, words: paragraphWords }) => {
    const totalWords = paragraphWords.length
    const timingAmbiguous = paragraphWords.some((_, index) =>
      ambiguous.has(offset + index),
    )
    const words = paragraphWords.flatMap((_, index) => {
      const match = matches.get(offset + index)
      return match ? [match] : []
    })
    offset += totalWords
    return {
      text, start: words[0]?.start ?? null,
      end: words.at(-1)?.end ?? null,
      confidence: totalWords === 0 ? 0 : words.length / totalWords,
      matchedWords: words.length, totalWords,
      needsReview: timingAmbiguous || totalWords === 0 || words.length !== totalWords,
      status: words.length === 0 ? "unmatched" : timingAmbiguous ? "ambiguous"
        : words.length === totalWords ? "matched" : "partial",
    }
  })
  return { segments }
}

/** Keep missing boundaries absent so cue validation requires correction. */
export function scriptAlignmentCues(
  result: ScriptAlignmentResult,
): TranslatableString[] {
  return result.segments.map(segment => ({
    id: uuidv7(), original: segment.text, translated: "",
    context: "", group: "", type: "cue",
    ...(segment.start !== null ? { start: segment.start } : {}),
    ...(segment.end !== null ? { end: segment.end } : {}),
    metadata: {
      alignmentConfidence: segment.confidence,
      alignmentStatus: segment.status,
      alignmentNeedsReview: segment.needsReview,
      alignmentMethod: result.method ?? "whisper-word-match",
      alignmentConfidenceBasis: result.method === "ctc-forced-alignment"
        ? "acoustic-score" : "word-match-coverage",
      alignmentMatchedWords: segment.matchedWords,
      alignmentTotalWords: segment.totalWords,
    },
  }))
}
