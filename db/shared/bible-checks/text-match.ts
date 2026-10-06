// Finding a Language-profile word in a cell's text (AQU-1688, AQU-1697).
//
// A word matches as a whole word, ignoring case, except in a script written
// without spaces between words (吗, 三), where it matches anywhere. The text
// and the word are compared in NFC, with the apostrophes ' ’ ʼ ＇ treated as one
// and runs of spaces as one space, so "doesn't" in the profile finds
// "doesn’t" in the text.
//
// Relative imports only, no DOM: shared with the workers.

/** Scripts written without spaces between words, where a particle sits against its neighbours. */
export const UNSPACED_SCRIPT =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]+$/u

/** A character that belongs to a word, for the whole-word and word-end tests. */
export const WORD_PART = '[\\p{L}\\p{M}\\p{N}]'

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const APOSTROPHES = /[’ʼ＇]/gu

/** The form both sides are compared in. */
export function normalizeForMatch(value: string): string {
  return value.normalize('NFC').replace(APOSTROPHES, "'").replace(/\s+/gu, ' ')
}

/** The pattern for one profile word: whole word, or anywhere for an unspaced script. */
function wordPattern(term: string): string | null {
  const value = normalizeForMatch(term).trim()
  if (!value) return null
  const word = escapeRegExp(value)
  return UNSPACED_SCRIPT.test(value.replace(/\s/gu, '')) ? word : `(?<!${WORD_PART})${word}(?!${WORD_PART})`
}

/** `term` appears in `text` as a whole word, ignoring case; anywhere, in a script written without spaces. */
export function containsWord(text: string, term: string): boolean {
  const pattern = wordPattern(term)
  return pattern !== null && new RegExp(pattern, 'iu').test(normalizeForMatch(text))
}

/** `text` ends with `term` (as a whole word, ignoring case; any way, in a script written without spaces). */
export function endsWithWord(text: string, term: string): boolean {
  const pattern = wordPattern(term)
  return pattern !== null && new RegExp(`(?:${pattern})$`, 'iu').test(normalizeForMatch(text).trimEnd())
}

/**
 * How many times the text has any of `terms`, each occurrence counted once:
 * the longest term wins where two overlap ("no one" over "no").
 */
export function containsWordCount(text: string, terms: readonly string[]): number {
  const patterns = [...terms]
    .sort((a, b) => b.length - a.length)
    .map(wordPattern)
    .filter((p): p is string => p !== null)
  if (patterns.length === 0) return 0
  return normalizeForMatch(text).match(new RegExp(patterns.join('|'), 'giu'))?.length ?? 0
}
