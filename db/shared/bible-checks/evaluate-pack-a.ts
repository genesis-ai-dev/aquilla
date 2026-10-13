// Check pack A, per cell (AQU-1697; design doc §7.4–7.6): numbers (N1, N2),
// negation (M3), a sentence that runs on into the next verse (S3), and verses
// some manuscripts leave out (S6, S7). S1 and S8 need the whole file: see
// ./scans.ts.
//
// Pure, like ./evaluate.ts, which runs these beside the quotation checks: the
// inputs are this cell's text, its expectation and the Language profile. The
// text is read with its footnotes and USFM markers blanked out (./usfm-mask.ts),
// so a note's "\fr 4:7" is not a number and its "not" is not a negation;
// only S6/S7's footnote policy reads the notes themselves.
//
// Relative imports only, no DOM: shared with the workers.

import type { LanguageProfile, QuestionMarkersProfile } from '../language-profile'
import { countNegators } from './negation'
import { digitNumbers, numberWordsMap, writesNumber } from './number-match'
import { wordNumber } from './refs'
import { endsWithWord } from './text-match'
import {
  BIBLE_CHECK_DEFAULT_SEVERITY,
  type BibleCheckEvidence,
  type BibleCheckFinding,
  type BibleCheckId,
  type BibleCheckReason,
  type BibleCheckSeverity,
  type BibleCheckSpan,
  type CellExpectation,
  type NumberFact,
} from './types'
import { hasFootnote } from './usfm-mask'

export interface PackACellInput {
  /** The cell's text with notes and markers blanked out: same length, same offsets. */
  text: string
  /** The cell's text as stored, notes included. */
  rawText: string
  expectation: CellExpectation
  profile: LanguageProfile
}

function finding(
  e: PackACellInput,
  code: BibleCheckId,
  reason: BibleCheckReason,
  params: Record<string, string>,
  evidence: BibleCheckEvidence,
  options: { severity?: BibleCheckSeverity; spans?: readonly BibleCheckSpan[] } = {},
): BibleCheckFinding {
  return {
    code,
    reason,
    params,
    severity: options.severity ?? BIBLE_CHECK_DEFAULT_SEVERITY[code],
    spans: options.spans ?? [],
    approximate: e.expectation.approximate,
    evidence,
  }
}

// ── N1, N2: the numbers stay ────────────────────────────────────────────────

function numberFinding(e: PackACellInput, fact: NumberFact): BibleCheckFinding | null {
  const words = numberWordsMap(e.profile.numberWords)
  const writing =
    fact.kind === 'cardinal' ? writesNumber(e.text, fact.value, fact.parts, words) : writesNumber(e.text, fact.value, [], null)
  if (writing.found) return null
  const code: BibleCheckId = fact.kind === 'cardinal' ? 'bkp:N1' : 'bkp:N2'
  const params: Record<string, string> = {
    value: String(fact.value),
    // How the check could have recognised it: digits only, or the profile's words as well.
    accepts: fact.kind === 'ordinal' || !words ? 'digits' : writing.hasWords ? 'digits-or-words' : 'digits-unlisted-word',
  }
  if (fact.approximate) params.about = 'true'
  if (fact.indefinite) params.indefinite = 'true'
  return finding(
    e,
    code,
    fact.kind === 'cardinal' ? 'number-missing' : 'ordinal-missing',
    params,
    { kind: 'number', refs: [fact.ref], startWord: wordNumber(fact.from), endWord: wordNumber(fact.to) },
    // "About five thousand" (N3's territory) and a lone εἷς that may be "a" are hints, not errors.
    { severity: fact.approximate || fact.indefinite ? 'info' : undefined },
  )
}

export function checkCardinals(e: PackACellInput): BibleCheckFinding | null {
  for (const fact of e.expectation.numbers) {
    if (fact.kind !== 'cardinal') continue
    const found = numberFinding(e, fact)
    if (found) return found
  }
  return null
}

/**
 * Ordinals are read as digits only ("3rd", "3."): the profile has no ordinal
 * words yet, and "third" is no number word for 3. So N2 checks only a cell
 * that writes numbers in digits; elsewhere it could not tell a kept "third"
 * from a dropped one.
 */
export function checkOrdinals(e: PackACellInput): BibleCheckFinding | null {
  if (digitNumbers(e.text).size === 0) return null
  for (const fact of e.expectation.numbers) {
    if (fact.kind !== 'ordinal') continue
    const found = numberFinding(e, fact)
    if (found) return found
  }
  return null
}

// ── M3: the negation stays ──────────────────────────────────────────────────

export function checkNegation(e: PackACellInput): BibleCheckFinding | null {
  const negation = e.expectation.negation
  const negators = e.profile.negators ?? []
  // An empty list names no negator, so nothing could ever pass.
  if (!negation || negators.length === 0) return null
  const found = countNegators(e.text, negators)
  if (found >= negation.units) return null
  return finding(
    e,
    'bkp:M3',
    found === 0 ? 'negation-missing' : 'negation-fewer',
    { expected: String(negation.units), found: String(found) },
    { kind: 'negation', refs: negation.refs },
    // No negation at all flips the meaning; less of it may be a merged clause.
    { severity: found === 0 ? undefined : 'info' },
  )
}

// ── S3: no full stop where the sentence goes on ─────────────────────────────

/**
 * Marks that end a sentence: . ! ? and their equivalents (Arabic ؟ ۔,
 * Devanagari । ॥, CJK 。！？．, Ethiopic ። ፧ ፨, Armenian ։, Myanmar ။,
 * Khmer ។ ៕, Syriac ܁ ܂, the Greek question mark ;).
 */
const SENTENCE_FINAL = /[.!?\u037E\u061F\u06D4\u0964\u0965\u3002\uFF01\uFF1F\uFF0E\u1362\u1367\u1368\u0589\u104B\u17D4\u17D5\u0701\u0702\u203C\u2047-\u2049\u2E2E]/u
/** What may follow the final mark: closing quotation marks, brackets and spaces. */
const TRAILING = /[\s"'”’»›)\]}⟧〛」』）”’]/u

/** Where the cell's last sentence-final mark is, when nothing but closing marks follows it. */
function sentenceEnd(text: string, markers: QuestionMarkersProfile | undefined): BibleCheckSpan | null {
  let end = text.length
  while (end > 0 && TRAILING.test(text[end - 1])) end--
  if (end === 0) return null
  if (SENTENCE_FINAL.test(text[end - 1])) return { start: end - 1, end }
  // A language that ends a question with a particle (Japanese か) ends the sentence with it.
  const tail = text.slice(0, end)
  const particle = (markers?.particles ?? []).find((p) => endsWithWord(tail, p))
  return particle ? { start: Math.max(0, end - particle.length), end } : null
}

export function checkSentenceRunsOn(e: PackACellInput): BibleCheckFinding | null {
  if (!e.expectation.continuesPast) return null
  const span = sentenceEnd(e.text, e.profile.questionMarkers)
  if (!span) return null
  const refs = e.expectation.refs
  return finding(e, 'bkp:S3', 'sentence-ends-early', {}, { kind: 'move', refs: [refs[refs.length - 1]] }, { spans: [span] })
}

// ── S6, S7: the project's policy for variant verses ─────────────────────────

const OPEN_BRACKET = /^[^\p{L}\p{N}]*[[⟦［〚]/u
const CLOSE_BRACKET = /[\]⟧］〛][^\p{L}\p{N}]*$/u
const ANY_OPEN_BRACKET = /[[⟦［〚]/u
const ANY_CLOSE_BRACKET = /[\]⟧］〛]/u

function checkVariant(e: PackACellInput, code: 'bkp:S6' | 'bkp:S7'): BibleCheckFinding | null {
  const variant = e.expectation.variant
  const policy = e.profile.textualVariants
  if (!variant || !policy || (variant.kind === 'absent') !== (code === 'bkp:S6')) return null
  // A split verse: only "leave it out" holds for every part.
  if (e.expectation.approximate && policy !== 'omit') return null
  const evidence: BibleCheckEvidence = { kind: 'variant', refs: variant.refs, passage: variant.passage }
  const params = { policy }
  const body = e.text.trim()
  if (policy === 'omit') {
    // A note that says the verse is left out is fine; text is not. A bridge
    // holds other verses too, so its text says nothing.
    if (variant.partial || body === '') return null
    return finding(e, code, 'variant-not-omitted', params, evidence)
  }
  if (policy === 'bracket') {
    const opened = variant.partial ? ANY_OPEN_BRACKET.test(body) : OPEN_BRACKET.test(body)
    const closed = variant.partial ? ANY_CLOSE_BRACKET.test(body) : CLOSE_BRACKET.test(body)
    if ((!variant.opens || opened) && (!variant.closes || closed)) return null
    return finding(e, code, 'variant-not-bracketed', params, evidence)
  }
  // footnote: the note goes where the variant begins.
  if (!variant.opens || hasFootnote(e.rawText)) return null
  return finding(e, code, 'variant-no-footnote', params, evidence)
}

export const checkAbsentVerse = (e: PackACellInput) => checkVariant(e, 'bkp:S6')
export const checkDisputedPassage = (e: PackACellInput) => checkVariant(e, 'bkp:S7')
