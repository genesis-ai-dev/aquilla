export interface AcousticAlignmentResult {
  method: "ctc-forced-alignment"
  segments: Array<{
    text: string
    start: number | null
    end: number | null
    confidence: number
    matchedWords: number
    totalWords: number
    needsReview: boolean
    status: "matched" | "partial" | "unmatched"
  }>
}

/** Validate model results at both server and browser boundaries. */
export function isAcousticAlignmentResult(
  value: unknown, script: string,
): value is AcousticAlignmentResult {
  if (!value || typeof value !== "object") return false
  const result = value as Record<string, unknown>
  const paragraphs = script.trim().split(/\r?\n\s*\r?\n/)
    .map(text => text.trim()).filter(Boolean)
  if (result.method !== "ctc-forced-alignment" || !Array.isArray(result.segments)
      || result.segments.length !== paragraphs.length || paragraphs.length === 0) return false
  let previousStart = -1
  return result.segments.every((raw: unknown, index: number) => {
    if (!raw || typeof raw !== "object") return false
    const segment = raw as Record<string, unknown>
    const { text, start, end, confidence, matchedWords, totalWords, needsReview, status } = segment
    if (text !== paragraphs[index] || typeof confidence !== "number"
        || !Number.isFinite(confidence) || confidence < 0 || confidence > 1
        || typeof needsReview !== "boolean"
        || typeof matchedWords !== "number" || !Number.isSafeInteger(matchedWords)
        || typeof totalWords !== "number" || !Number.isSafeInteger(totalWords)
        || matchedWords < 0 || totalWords < matchedWords) return false
    if (start === null && end === null) {
      if (matchedWords !== 0 || !needsReview || status !== "unmatched") return false
    } else {
      if (typeof start !== "number" || typeof end !== "number"
          || !Number.isFinite(start) || !Number.isFinite(end)
          || start < 0 || end <= start || start < previousStart || matchedWords === 0) return false
      previousStart = start
    }
    if (status === "matched") {
      if (totalWords === 0 || matchedWords !== totalWords) return false
    } else if (status === "partial") {
      if (matchedWords === 0 || matchedWords >= totalWords || !needsReview) return false
    } else if (status !== "unmatched" || matchedWords !== 0 || !needsReview) return false
    return (confidence >= 0.8 || needsReview)
      && (matchedWords > 0 || confidence === 0)
  })
}
export const ALIGNMENT_JOB_TIMEOUT_MS = 30 * 60 * 1000
