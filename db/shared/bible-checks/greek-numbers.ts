// Greek numbers for the number checks N1 and N2 (AQU-1697; design doc §7.4).
//
// The structure layer lists a verse's `numerals`, but those are Macula's class
// "num": the indeclinable numerals only (πέντε, ἑκατόν, πεντήκοντα). The
// declinable ones are class "adj" (εἷς, τρεῖς, τέσσαρες, χίλιοι,
// πεντακισχίλιοι), so JHN 21:11's 153, ἑκατὸν πεντήκοντα τριῶν, has only two
// "num" words. A number's VALUE therefore comes from the text layer's lemmas
// through the tables below, which cover every class "num" lemma in the pack
// as well.
//
// Values: the standard Koine numerals. Lemma spellings: as Macula Greek
// (SBLGNT) writes them in the pack's text layer (BKP 1.1.0), NFC. Every
// lemma below occurs there.
//
// Relative imports only, no DOM: shared with the workers.

import { wordNumber } from './refs'
import type { NumberFact, TextLayerInput } from './types'

interface CardinalLemma {
  value: number
  /**
   * The value as a translation may write it word by word: πεντακισχίλιοι is
   * 5 × 1000, "five thousand". Most lemmas are one part.
   */
  parts?: readonly number[]
}

/** Cardinal numbers by lemma. */
export const CARDINAL_LEMMAS: Readonly<Record<string, CardinalLemma>> = {
  'εἷς': { value: 1 },
  'δύο': { value: 2 },
  'τρεῖς': { value: 3 },
  'τέσσαρες': { value: 4 },
  'πέντε': { value: 5 },
  'ἕξ': { value: 6 },
  'ἑπτά': { value: 7 },
  'ὀκτώ': { value: 8 },
  'ἐννέα': { value: 9 },
  'δέκα': { value: 10 },
  'ἕνδεκα': { value: 11 },
  'δώδεκα': { value: 12 },
  'δεκατέσσαρες': { value: 14 },
  'δεκαπέντε': { value: 15 },
  'δεκαοκτώ': { value: 18 },
  'εἴκοσι(ν)': { value: 20 },
  'τριάκοντα': { value: 30 },
  'τεσσεράκοντα': { value: 40 },
  'πεντήκοντα': { value: 50 },
  'ἑξήκοντα': { value: 60 },
  'ἑβδομήκοντα': { value: 70 },
  'ὀγδοήκοντα': { value: 80 },
  'ἐνενήκοντα': { value: 90 },
  'ἑκατόν': { value: 100 },
  'διακόσιοι': { value: 200, parts: [2, 100] },
  'τριακόσιοι': { value: 300, parts: [3, 100] },
  'τετρακόσιοι': { value: 400, parts: [4, 100] },
  'πεντακόσιοι': { value: 500, parts: [5, 100] },
  'ἑξακόσιοι': { value: 600, parts: [6, 100] },
  'χίλιοι': { value: 1000 },
  'δισχίλιοι': { value: 2000, parts: [2, 1000] },
  'τρισχίλιοι': { value: 3000, parts: [3, 1000] },
  'τετρακισχίλιοι': { value: 4000, parts: [4, 1000] },
  'πεντακισχίλιοι': { value: 5000, parts: [5, 1000] },
  'ἑπτακισχίλιοι': { value: 7000, parts: [7, 1000] },
  'μύριοι': { value: 10000, parts: [10, 1000] },
}

/**
 * Nouns that multiply the number before them: δώδεκα χιλιάδες is 12 000
 * (REV 7:5). Alone they are vague ("myriads of angels", HEB 12:22), so a
 * group of multipliers only is not a number to check.
 */
export const MULTIPLIER_LEMMAS: Readonly<Record<string, CardinalLemma>> = {
  'χιλιάς': { value: 1000 },
  'μυριάς': { value: 10000, parts: [10, 1000] },
  'δισμυριάς': { value: 20000, parts: [2, 10, 1000] },
}

/**
 * Ordinal numbers by lemma (N2: "the third day", "the sixth hour").
 * πρῶτος is left out: it ranks more often than it counts ("first of all",
 * "the leading men", the adverb πρῶτον), so its translation is rarely a number.
 */
export const ORDINAL_LEMMAS: Readonly<Record<string, number>> = {
  'δεύτερος': 2,
  'τρίτος': 3,
  'τέταρτος': 4,
  'πέμπτος': 5,
  'ἕκτος': 6,
  'ἕβδομος': 7,
  'ὄγδοος': 8,
  'ἔνατος': 9,
  'δέκατος': 10,
  'ἑνδέκατος': 11,
  'δωδέκατος': 12,
  'τεσσαρεσκαιδέκατος': 14,
  'πεντεκαιδέκατος': 15,
}

/** "About": ὡς πεντακισχίλιοι (JHN 6:10), ὥρα ἦν ὡς ἕκτη (JHN 4:6). */
export const APPROXIMATION_LEMMAS: ReadonlySet<string> = new Set(['ὡς', 'ὡσεί'])
/** How far before a number "about" may stand: ὡς σταδίους εἴκοσι πέντε (JHN 6:19). */
const APPROXIMATION_REACH = 3
/** Joins the parts of one number: τεσσεράκοντα καὶ ἓξ ἔτεσιν, forty-six years (JHN 2:20). */
const JOINER_LEMMA = 'καί'
/**
 * A lone εἷς that Macula renders "alone", "first", "same", "another"… is not
 * a count (εἰ μὴ εἷς ὁ θεός, "but God alone", MRK 2:7; μιᾷ τῶν σαββάτων,
 * "the first day of the week"), so there is no number to keep. One rendered
 * "one" or "a" may be "a certain" (εἷς γραμματεύς, "a scribe", MAT 8:19), so
 * its finding is info.
 */
const NOT_A_COUNT = /(?:^|[^\p{L}])(?:alone|only|first|same|another|other|individual|single|unity|unison)(?=$|[^\p{L}])/iu

/** Every lemma the number checks read. A compact text layer keeps the words with these lemmas. */
export function isNumberCheckLemma(lemma: string): boolean {
  const key = lemma.normalize('NFC')
  return (
    Object.hasOwn(CARDINAL_LEMMAS, key) ||
    Object.hasOwn(MULTIPLIER_LEMMAS, key) ||
    Object.hasOwn(ORDINAL_LEMMAS, key) ||
    APPROXIMATION_LEMMAS.has(key) ||
    key === JOINER_LEMMA
  )
}

interface VerseWord {
  id: string
  position: number
  lemma: string
  gloss: string
}

function verseWords(text: TextLayerInput, ref: string): VerseWord[] {
  const out: VerseWord[] = []
  for (const id of Object.hasOwn(text.verses, ref) ? text.verses[ref] : []) {
    const word = Object.hasOwn(text.words, id) ? text.words[id] : undefined
    if (!word?.lemma) continue
    out.push({
      id,
      position: wordNumber(id),
      lemma: word.lemma.normalize('NFC'),
      gloss: `${word.gloss ?? ''} ${word.english ?? ''}`,
    })
  }
  return out.sort((a, b) => a.position - b.position)
}

const isCountWord = (w: VerseWord) => Object.hasOwn(CARDINAL_LEMMAS, w.lemma) || Object.hasOwn(MULTIPLIER_LEMMAS, w.lemma)

/** Runs of count words that make one number: next to each other, or joined by καί. */
function countGroups(words: readonly VerseWord[]): VerseWord[][] {
  const byPosition = new Map(words.map((w) => [w.position, w]))
  const groups: VerseWord[][] = []
  let current: VerseWord[] = []
  for (const word of words) {
    if (!isCountWord(word)) continue
    const last = current[current.length - 1]
    const joined =
      last !== undefined &&
      (word.position === last.position + 1 ||
        (word.position === last.position + 2 && byPosition.get(last.position + 1)?.lemma === JOINER_LEMMA))
    if (!joined && current.length > 0) {
      groups.push(current)
      current = []
    }
    current.push(word)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** A group's value: additive, with each multiplier scaling what came before it (or after it, when it leads). */
function groupValue(group: readonly VerseWord[]): { value: number; parts: number[] } | null {
  let sum = 0
  let leadingMultiplier = 1
  let hasBase = false
  const parts: number[] = []
  let previous: string | null = null
  for (const word of group) {
    // δύο δύο, "two by two" (MRK 6:7), is one number said twice.
    if (word.lemma === previous) continue
    previous = word.lemma
    const multiplier = Object.hasOwn(MULTIPLIER_LEMMAS, word.lemma) ? MULTIPLIER_LEMMAS[word.lemma] : undefined
    if (multiplier) {
      if (sum === 0) leadingMultiplier *= multiplier.value
      else sum *= multiplier.value
      parts.push(...(multiplier.parts ?? [multiplier.value]))
      continue
    }
    const cardinal = CARDINAL_LEMMAS[word.lemma]
    sum += cardinal.value
    hasBase = true
    parts.push(...(cardinal.parts ?? [cardinal.value]))
  }
  if (!hasBase) return null
  return { value: sum * leadingMultiplier, parts }
}

function approximated(words: readonly VerseWord[], firstPosition: number): boolean {
  return words.some(
    (w) =>
      APPROXIMATION_LEMMAS.has(w.lemma) && w.position < firstPosition && firstPosition - w.position <= APPROXIMATION_REACH,
  )
}

/**
 * The numbers one verse states: cardinals (N1), each group of adjacent
 * number words as one value, and ordinals (N2). Empty without the text layer,
 * since a value needs the lemma.
 */
export function verseNumbers(ref: string, text: TextLayerInput | null | undefined): NumberFact[] {
  if (!text) return []
  const words = verseWords(text, ref)
  const facts: NumberFact[] = []
  for (const group of countGroups(words)) {
    const counted = groupValue(group)
    if (!counted) continue
    const first = group[0]
    const last = group[group.length - 1]
    const lone = group.length === 1 && first.lemma === 'εἷς'
    if (lone && NOT_A_COUNT.test(first.gloss)) continue
    facts.push({
      kind: 'cardinal',
      ref,
      value: counted.value,
      parts: counted.parts,
      from: first.id,
      to: last.id,
      approximate: approximated(words, first.position),
      indefinite: lone,
    })
  }
  for (const word of words) {
    if (!Object.hasOwn(ORDINAL_LEMMAS, word.lemma)) continue
    const value = ORDINAL_LEMMAS[word.lemma]
    facts.push({
      kind: 'ordinal',
      ref,
      value,
      parts: [value],
      from: word.id,
      to: word.id,
      approximate: approximated(words, word.position),
      indefinite: false,
    })
  }
  return facts.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
}
