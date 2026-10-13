// Does a translation write a number? (AQU-1697: N1 and N2.)
//
// As digits, in any decimal digit system Unicode knows (Latin 153, Devanagari
// १५३, Arabic-Indic ١٥٣, Thai ๑๕๓, Myanmar ၁၅၃, full-width １５３), with or
// without group separators (144,000; 144 000; 1,44,000). Or, when the
// Language profile lists number words, as the word for the whole value, or as
// the words for each part the Greek names (ἑκατὸν πεντήκοντα τριῶν: 100, 50
// and 3, so "one hundred fifty-three" needs "hundred", "fifty" and "three").
//
// Relative imports only, no DOM: shared with the workers.

import type { NumberWordsProfile } from '../language-profile'
import { containsWord } from './text-match'

const DECIMAL_DIGIT = /\p{Nd}/u
const digitValues = new Map<number, number>()

/**
 * A decimal digit's value. Unicode encodes each system's digits as a block of
 * ten, zero first, and some blocks sit back to back (the mathematical
 * digits), so the value is the distance from the start of the run, mod 10.
 */
function digitValue(codePoint: number): number {
  const cached = digitValues.get(codePoint)
  if (cached !== undefined) return cached
  let start = codePoint
  while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start--
  const value = (codePoint - start) % 10
  digitValues.set(codePoint, value)
  return value
}

/** Between two groups of a number: 144,000 · 144.000 · 144 000 (with a space or narrow space) · 144’000. */
const GROUP_SEPARATOR = /^[,.\u00A0\u202F\u2009 '’]$/u

/**
 * Every value the text writes in digits. A run with separators yields both the
 * whole number and each group, so "144,000" gives 144000, 144 and 0 and
 * "3, 4" gives 3 and 4: a reading the text supports is never missed.
 */
export function digitNumbers(text: string): Set<number> {
  const values = new Set<number>()
  const chars = Array.from(text)
  let i = 0
  while (i < chars.length) {
    if (!DECIMAL_DIGIT.test(chars[i])) {
      i++
      continue
    }
    const groups: string[] = []
    let group = ''
    while (i < chars.length) {
      const char = chars[i]
      if (DECIMAL_DIGIT.test(char)) {
        group += String(digitValue(char.codePointAt(0) ?? 0))
        i++
      } else if (group && GROUP_SEPARATOR.test(char) && i + 1 < chars.length && DECIMAL_DIGIT.test(chars[i + 1])) {
        groups.push(group)
        group = ''
        i++
      } else {
        break
      }
    }
    groups.push(group)
    for (const g of groups) values.add(Number.parseInt(g, 10))
    // Thousands groups have three digits (Indian grouping two, then three).
    const grouped = groups.slice(1).every((g) => g.length === 3 || g.length === 2)
    if (groups.length > 1 && grouped) values.add(Number.parseInt(groups.join(''), 10))
  }
  return values
}

/** How the profile lets a number be written: digits only, or the listed words too. */
export function numberWordsMap(profile: NumberWordsProfile | undefined): Readonly<Record<string, string>> | null {
  return profile !== undefined && profile !== 'cldr' ? profile : null
}

export interface NumberWriting {
  /** The text writes the value. */
  found: boolean
  /** The profile lists a word for the value, or for each of its parts. */
  hasWords: boolean
}

/** Does `text` write `value` (whose Greek parts are `parts`) as digits or as the profile's words? */
export function writesNumber(
  text: string,
  value: number,
  parts: readonly number[],
  words: Readonly<Record<string, string>> | null,
): NumberWriting {
  const whole = words && Object.hasOwn(words, String(value)) ? words[String(value)] : undefined
  const partWords = words ? parts.map((part) => (Object.hasOwn(words, String(part)) ? words[String(part)] : undefined)) : []
  const hasPartWords = partWords.length > 0 && partWords.every((w) => w !== undefined)
  const hasWords = whole !== undefined || hasPartWords
  if (digitNumbers(text).has(value)) return { found: true, hasWords }
  if (whole !== undefined && containsWord(text, whole)) return { found: true, hasWords }
  if (hasPartWords && partWords.every((w) => w !== undefined && containsWord(text, w))) return { found: true, hasWords }
  return { found: false, hasWords }
}
