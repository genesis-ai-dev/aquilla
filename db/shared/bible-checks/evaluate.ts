// Evaluate one cell's text against its compiled expectation (AQU-1688).
//
// Pure: the inputs are this cell's own text, its expectation (pack facts only,
// see ./compile.ts) and the project's Language profile. Nothing here can read
// another cell, so a keystroke in one cell never re-evaluates another.
//
// Each check returns at most one finding per cell: waivers are per cell and
// per check, and the first problem is the one to fix. Findings carry reason
// codes and parameters, never sentences.
//
// Relative imports only, no DOM: shared with the workers.

import {
  filledLanguageProfileSlots,
  type LanguageProfile,
  type QuestionMarkersProfile,
  type QuoteMarksProfile,
} from '../language-profile'
import { isMarkedSpeech } from './compile'
import { scanQuotes, type QuoteToken } from './quote-scan'
import { wordNumber, wordRef } from './refs'
import {
  BIBLE_CHECK_DEFAULT_SEVERITY,
  BIBLE_CHECK_NEEDS,
  type BibleCheckEvidence,
  type BibleCheckFinding,
  type BibleCheckId,
  type BibleCheckReason,
  type CellExpectation,
  type SpeechExpectation,
} from './types'

/**
 * Question marks across scripts: ? ¿ ; (Greek) ՞ (Armenian) ؟ (Arabic)
 * ፧ (Ethiopic) ‽ ⁇ ⁈ ⁉ ⸮ and the full-width and small forms.
 */
export const QUESTION_MARK = /[?¿;՞؟፧‽⁇-⁉⸮︖﹖？]/u

/** Scripts written without spaces between words, where a particle sits against its neighbours. */
export const UNSPACED_SCRIPT =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]+$/u

/** A character that belongs to a word, for the whole-word and word-end tests below. */
export const WORD_PART = '[\\p{L}\\p{M}\\p{N}]'

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The cell marks a question: with a question mark, or with one of the
 * Language profile's question markers (AQU-1691). A particle counts as a whole
 * word, except in a script written without spaces (吗), where it counts
 * anywhere. A suffix counts at the end of a word (Finnish "onko").
 */
function marksQuestion(text: string, markers: QuestionMarkersProfile | undefined): boolean {
  if (QUESTION_MARK.test(text)) return true
  for (const particle of markers?.particles ?? []) {
    const word = escapeRegExp(particle)
    const pattern = UNSPACED_SCRIPT.test(particle) ? word : `(?<!${WORD_PART})${word}(?!${WORD_PART})`
    if (new RegExp(pattern, 'iu').test(text)) return true
  }
  for (const suffix of markers?.suffix ?? []) {
    if (new RegExp(`(?<=${WORD_PART})${escapeRegExp(suffix)}(?!${WORD_PART})`, 'iu').test(text)) return true
  }
  return false
}

/**
 * In a cell with no speech, a quoted stretch this short is taken as a title,
 * a gloss or scare quotes, which V7 allows. Five words covers names such as
 * “The place of a skull” (WEB, MAT 27:33).
 */
export const MAX_SCARE_QUOTE_WORDS = 5

const WORD_CHAR = /[\p{L}\p{N}]/u

interface LevelExpectation {
  /** Speeches at this level whose first or last word is in the cell. */
  opens: number
  closes: number
  /** Reopens and closes caused by an interruption inside the cell. */
  reopens: number
  recloses: number
  /** A quotation at this level is still open when the cell ends. */
  continuesPast: boolean
}

interface Evaluation {
  text: string
  expectation: CellExpectation
  marks: QuoteMarksProfile | null
  questionMarkers: QuestionMarkersProfile | undefined
  tokens: QuoteToken[]
  /** Opening marks by the level they opened. */
  opens: Map<number, QuoteToken[]>
  /** Closing marks by level, stray closes included: a close with no open still closes. */
  closes: Map<number, QuoteToken[]>
  levels: Map<number, LevelExpectation>
}

/** True when a check cannot run because its Language-profile slot is empty. */
export function isBibleCheckDormant(id: BibleCheckId, profile: LanguageProfile | null | undefined): boolean {
  const filled = filledLanguageProfileSlots(profile)
  return BIBLE_CHECK_NEEDS[id].some((slot) => !filled.has(slot))
}

function expectedByLevel(expectation: CellExpectation): Map<number, LevelExpectation> {
  const levels = new Map<number, LevelExpectation>()
  for (const speech of expectation.speeches) {
    if (!isMarkedSpeech(speech)) continue
    const level = levels.get(speech.level) ?? { opens: 0, closes: 0, reopens: 0, recloses: 0, continuesPast: false }
    if (speech.opens) level.opens++
    if (speech.closes) level.closes++
    level.reopens += speech.interruptOpens
    level.recloses += speech.interruptCloses
    if (speech.openAtEnd) level.continuesPast = true
    levels.set(speech.level, level)
  }
  return new Map([...levels].sort(([a], [b]) => a - b))
}

function byDepth(tokens: QuoteToken[], kinds: readonly QuoteToken['kind'][]): Map<number, QuoteToken[]> {
  const out = new Map<number, QuoteToken[]>()
  for (const token of tokens) {
    if (!kinds.includes(token.kind)) continue
    const list = out.get(token.depth) ?? []
    list.push(token)
    out.set(token.depth, list)
  }
  return out
}

const count = (map: Map<number, QuoteToken[]>, level: number) => map.get(level)?.length ?? 0

function speechEvidence(book: string, speech: SpeechExpectation): BibleCheckEvidence {
  return {
    kind: 'speech',
    speechId: speech.id,
    startRef: wordRef(book, speech.from),
    startWord: wordNumber(speech.from),
    endRef: wordRef(book, speech.to),
    endWord: wordNumber(speech.to),
    speakerSources: speech.speakerSources,
    speakerConf: speech.speakerConf,
  }
}

/** The quoted speech at `level` that best explains a finding, else the deepest one in the cell. */
function evidenceAt(e: Evaluation, level: number, prefer: (s: SpeechExpectation) => boolean): BibleCheckEvidence {
  const marked = e.expectation.speeches.filter(isMarkedSpeech)
  const atLevel = marked.filter((s) => s.level === level)
  const speech = atLevel.find(prefer) ?? atLevel[0] ?? marked[marked.length - 1]
  return speech
    ? speechEvidence(e.expectation.book, speech)
    : { kind: 'no-speech', refs: e.expectation.refs }
}

function finding(
  e: Evaluation,
  code: BibleCheckId,
  reason: BibleCheckReason,
  params: Record<string, string>,
  evidence: BibleCheckEvidence,
  spans: readonly QuoteToken[] = [],
): BibleCheckFinding {
  return {
    code,
    reason,
    params,
    severity: BIBLE_CHECK_DEFAULT_SEVERITY[code],
    spans: spans.map(({ start, end }) => ({ start, end })),
    approximate: e.expectation.approximate,
    evidence,
  }
}

// ── V1, V2: a quotation opens or closes in this cell ────────────────────────

function checkOpens(e: Evaluation): BibleCheckFinding | null {
  for (const [level, expected] of e.levels) {
    const found = count(e.opens, level)
    if (expected.opens > 0 && found < expected.opens) {
      return finding(
        e, 'bkp:V1', 'open-missing',
        { level: String(level), expected: String(expected.opens), found: String(found) },
        evidenceAt(e, level, (s) => s.opens),
      )
    }
  }
  return null
}

/** The close that last brought the text back down to `endLevel` or below. */
function lastReturnTo(e: Evaluation, endLevel: number): QuoteToken | null {
  let depth = e.expectation.startDepth
  let lastReturn: QuoteToken | null = null
  for (const token of e.tokens) {
    if (token.kind === 'open') depth = token.depth
    else if (token.kind === 'close') {
      const before = depth
      depth = token.depth - 1
      if (before > endLevel && depth <= endLevel) lastReturn = token
    }
  }
  return lastReturn
}

function hasWordsAfter(e: Evaluation, token: QuoteToken): boolean {
  const nextOpen = e.tokens.find((t) => t.kind === 'open' && t.start >= token.end)
  return WORD_CHAR.test(e.text.slice(token.end, nextOpen?.start))
}

function checkCloses(e: Evaluation): BibleCheckFinding | null {
  for (const [level, expected] of e.levels) {
    const found = count(e.closes, level)
    if (expected.closes > 0 && found < expected.closes) {
      return finding(
        e, 'bkp:V2', 'close-missing',
        { level: String(level), expected: String(expected.closes), found: String(found) },
        evidenceAt(e, level, (s) => s.closes),
      )
    }
  }
  // The quotation must close before the narration that ends the cell (the
  // aside after the woman's question in JHN 4:9), not after it.
  const trailing = e.expectation.trailingNarration
  if (!trailing || e.expectation.approximate) return null
  const close = lastReturnTo(e, trailing.endLevel)
  if (!close || hasWordsAfter(e, close)) return null
  const speech = e.expectation.speeches.find((s) => s.id === trailing.speechId)
  return finding(
    e, 'bkp:V2', 'close-after-aside',
    { level: String(trailing.closeLevel) },
    speech ? speechEvidence(e.expectation.book, speech) : evidenceAt(e, trailing.closeLevel, () => true),
    [close],
  )
}

// ── V3: no close where the quotation continues past the cell ────────────────

function checkContinuingCloses(e: Evaluation): BibleCheckFinding | null {
  for (const [level, expected] of e.levels) {
    if (!expected.continuesPast) continue
    const closes = e.closes.get(level) ?? []
    const allowed = expected.closes + expected.recloses
    if (closes.length > allowed) {
      return finding(
        e, 'bkp:V3', 'close-in-continuing-speech',
        { level: String(level), found: String(closes.length - allowed) },
        evidenceAt(e, level, (s) => s.openAtEnd),
        closes.slice(allowed),
      )
    }
  }
  return null
}

// ── V5: levels 2 and 3 use their own marks ──────────────────────────────────

function checkLevelMarks(e: Evaluation): BibleCheckFinding | null {
  const marks = e.marks
  if (!marks || !e.expectation.speeches.some((s) => isMarkedSpeech(s) && s.level >= 2)) return null
  const wrong = e.tokens.filter((token) => {
    if (token.kind !== 'open' || token.depth < 2 || token.depth > marks.levels.length) return false
    return marks.levels[token.set - 1].open !== marks.levels[token.depth - 1].open
  })
  if (wrong.length === 0) return null
  const level = wrong[0].depth
  const pair = marks.levels[level - 1]
  return finding(
    e, 'bkp:V5', 'wrong-level-marks',
    { level: String(level), open: pair.open, close: pair.close },
    evidenceAt(e, level, (s) => s.opens),
    wrong,
  )
}

// ── V7: no quotation marks where nobody speaks ──────────────────────────────

function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length
}

function checkMarksWithoutSpeech(e: Evaluation): BibleCheckFinding | null {
  if (e.expectation.speeches.length > 0) return null
  const marks = e.tokens.filter((t) => t.kind !== 'continuation')
  const allowed = new Set<QuoteToken>()
  for (let i = 0; i + 1 < marks.length; i++) {
    const [open, close] = [marks[i], marks[i + 1]]
    if (open.kind !== 'open' || close.kind !== 'close' || close.depth !== open.depth) continue
    if (wordCount(e.text.slice(open.end, close.start)) > MAX_SCARE_QUOTE_WORDS) continue
    allowed.add(open)
    allowed.add(close)
    i++
  }
  const flagged = marks.filter((t) => !allowed.has(t))
  if (flagged.length === 0) return null
  return finding(
    e, 'bkp:V7', 'marks-without-speech',
    { count: String(flagged.length) },
    { kind: 'no-speech', refs: e.expectation.refs },
    flagged,
  )
}

// ── V8: an interrupted quotation closes and reopens ─────────────────────────

function checkInterruptions(e: Evaluation): BibleCheckFinding | null {
  for (const [level, expected] of e.levels) {
    if (expected.reopens + expected.recloses === 0) continue
    const opens = count(e.opens, level)
    const closes = count(e.closes, level)
    // V1 and V2 already report a quotation that is not opened or closed at all.
    if (opens < expected.opens || closes < expected.closes) continue
    if (opens < expected.opens + expected.reopens || closes < expected.closes + expected.recloses) {
      return finding(
        e, 'bkp:V8', 'interruption-not-marked',
        { level: String(level) },
        evidenceAt(e, level, (s) => s.interrupted),
      )
    }
  }
  return null
}

// ── V9: a self-projected speech adds no quote level ─────────────────────────

function checkSelfProjection(e: Evaluation): BibleCheckFinding | null {
  const selfProjected = e.expectation.speeches.find((s) => s.selfProjected)
  if (!selfProjected) return null
  const level = selfProjected.level + 1
  const expected = e.levels.get(level)
  const allowed = (expected?.opens ?? 0) + (expected?.reopens ?? 0)
  const opens = e.opens.get(level) ?? []
  if (opens.length <= allowed) return null
  return finding(
    e, 'bkp:V9', 'self-projection-adds-level',
    { level: String(level) },
    speechEvidence(e.expectation.book, selfProjected),
    opens.slice(0, opens.length - allowed),
  )
}

// ── M1: a question keeps its question mark ──────────────────────────────────

function checkQuestion(e: Evaluation): BibleCheckFinding | null {
  const question = e.expectation.question
  if (!question.expected || marksQuestion(e.text, e.questionMarkers)) return null
  const found = finding(e, 'bkp:M1', 'question-mark-missing', {}, { kind: 'question', refs: e.expectation.refs })
  // The hook for Translation Notes: a rhetorical question may become a statement.
  return question.rhetorical ? { ...found, severity: 'info' } : found
}

const CHECKS: readonly (readonly [BibleCheckId, (e: Evaluation) => BibleCheckFinding | null])[] = [
  ['bkp:V1', checkOpens],
  ['bkp:V2', checkCloses],
  ['bkp:V3', checkContinuingCloses],
  ['bkp:V5', checkLevelMarks],
  ['bkp:V7', checkMarksWithoutSpeech],
  ['bkp:V8', checkInterruptions],
  ['bkp:V9', checkSelfProjection],
  ['bkp:M1', checkQuestion],
]

/**
 * In a split verse this cell holds only part of the verse, so where a mark
 * falls is unknown. These checks hold for every part of a verse with no
 * quotation boundary in it; the rest would guess.
 */
const VERSE_LEVEL_CHECKS: ReadonlySet<BibleCheckId> = new Set(['bkp:V3', 'bkp:V5', 'bkp:V7', 'bkp:V9'])

/**
 * Every finding for one cell. Empty when the cell has no expectation, its text
 * is empty (the empty-translation check covers that), or every check is
 * dormant because its Language-profile slot is empty.
 */
export function evaluateCell(
  targetText: string,
  expectation: CellExpectation | null | undefined,
  languageProfile: LanguageProfile | null | undefined,
): BibleCheckFinding[] {
  const filled = filledLanguageProfileSlots(languageProfile)
  const active = CHECKS.filter(([id]) => BIBLE_CHECK_NEEDS[id].every((slot) => filled.has(slot)))
  if (active.length === 0 || !expectation || targetText.trim() === '') return []
  const marks = languageProfile?.quoteMarks ?? null
  const tokens = marks ? scanQuotes(targetText, marks, expectation.startDepth).tokens : []
  const e: Evaluation = {
    text: targetText,
    expectation,
    marks,
    questionMarkers: languageProfile?.questionMarkers,
    tokens,
    opens: byDepth(tokens, ['open']),
    closes: byDepth(tokens, ['close', 'stray-close']),
    levels: expectedByLevel(expectation),
  }
  const runnable = expectation.approximate
    ? expectation.boundaries ? [] : active.filter(([id]) => VERSE_LEVEL_CHECKS.has(id))
    : active
  const findings: BibleCheckFinding[] = []
  for (const [, check] of runnable) {
    const result = check(e)
    if (result) findings.push(result)
  }
  return findings
}
