/**
 * Capitalization checks (AQU-1734) — Paratext parity, without Paratext's setup.
 *
 * Paratext needs three hand-built inventories for this class of problem:
 * markers followed by a lowercase letter, punctuation followed by a lowercase
 * letter, and mixed capitalization inside a word. This module derives all
 * three from the text itself, so a project gets the checks with no
 * configuration at all.
 *
 * Pure, locale-less, no I/O: the findings are CODES + offsets, never
 * sentences, so `rule-engine.ts` (the hot keystroke path) can call into it
 * and the render site translates — the same split `RuleInfractionReason`
 * already uses.
 *
 * ## Which class runs where, and why
 *
 * `findLowercaseStarts` is **per cell** and lands as the `capitalization`
 * built-in check: a lowercase letter after sentence-final punctuation, or
 * right after a heading/paragraph marker, is decidable from the cell alone.
 *
 * `findMixedCaseWords` is **corpus-scoped** and deliberately NOT a built-in
 * check. `tHe` (a typo) and `kiSwahili` (a noun-class prefix) are
 * structurally identical — a lowercase prefix, then a capital, then more
 * lowercase. Nothing inside one cell can tell them apart; only how often the
 * form recurs can. So the mixed-case scan runs where a corpus is in hand (the
 * deterministic "Check file" pass, `src/lib/check/deterministic-check.ts`),
 * learns its exceptions from that corpus with `learnCaseExceptions`, and
 * reports the forms it excepted so a human can see what was let through.
 * Wiring it into the per-cell path instead would flag a project's noun-class
 * prefix on every cell that uses it — exactly the "flagged hundreds of times"
 * failure this ticket exists to avoid.
 *
 * ## Caseless scripts
 *
 * Every entry point returns nothing for text with no cased letters at all
 * (Arabic, Hebrew, Thai, CJK, …): "capital" is not a concept there, and
 * `toUpperCase()` is the identity, so every heuristic below would either
 * misfire or read as a flood of findings. Mixed-script text keeps the checks
 * for its cased words.
 */

export type CapitalizationCode =
  /** A lowercase letter opening a sentence, after sentence-final punctuation. */
  | "lowercase-after-terminator"
  /** A lowercase letter opening the text after a paragraph/heading marker. */
  | "lowercase-after-marker"
  /** A capital inside a word, after a lowercase letter (`tHe`, `kiSwahili`). */
  | "mixed-case"

export interface CapitalizationSpan {
  code: CapitalizationCode
  /** Character offset (inclusive) of the offending WORD in the text. */
  start: number
  /** Character offset (exclusive). */
  end: number
  /** The offending word, verbatim — raw content, never translated. */
  matchedText: string
}

/**
 * Sentence-final marks, matching the harmonizer's target-side set
 * (`src/lib/harmonizer/sentence.ts`): a colon or semicolon followed by
 * lowercase is ordinary prose in many languages, so neither is included.
 */
const TERMINATORS = ".!?։۔؟।॥。！？።"

/** Closers allowed between the terminator and the whitespace: `he said." then` */
const CLOSERS = "\"'”’»›）)\\]}」』"

const TERMINATOR_RE = new RegExp(
  `[${TERMINATORS}][${CLOSERS}]*\\s+([\\p{L}][\\p{L}\\p{M}'’-]*)`,
  "gu",
)

/**
 * Paragraph, poetry and heading markers. USFM's parsers strip most container
 * markers before a cell is written (see `extractUsfmStrings`), so this fires
 * on the formats that keep them (lossless USFM, pasted markup) rather than on
 * every verse — but when a marker IS in the cell, the letter after it opens a
 * paragraph or a heading and belongs in capitals.
 */
const MARKER_RE = /\\(?:p|m|pi\d?|mi|nb|cls|q\d?|qc|qr|qm\d?|li\d?|lh|lf|sp|sd\d?|s\d?|ms\d?|mr|sr|r|d|b)\s+([\p{L}][\p{L}\p{M}'’-]*)/gu

const WORD_RE = /[\p{L}\p{M}'’-]+/gu

/**
 * Abbreviations whose trailing period is not a sentence end. Deliberately
 * short and English-biased: it exists to keep the check quiet on the source-
 * like prose that actually occurs in these projects, not to be an inventory.
 * The frequency learner is the general answer; this is the cheap half.
 */
const ABBREVIATIONS = new Set([
  "e.g", "i.e", "etc", "cf", "vs", "viz", "al", "ca", "approx", "no", "vol",
  "mr", "mrs", "ms", "dr", "st", "prof", "rev", "fig", "ch", "chap", "v", "vv",
])

const isUpper = (ch: string): boolean => ch !== ch.toLowerCase() && ch === ch.toUpperCase()
const isLower = (ch: string): boolean => ch !== ch.toUpperCase() && ch === ch.toLowerCase()

/** True when at least one letter in `text` has distinct cases. */
export function hasCasedLetters(text: string): boolean {
  for (const ch of text) {
    if (ch.toLowerCase() !== ch.toUpperCase()) return true
  }
  return false
}

/** True when the first letter of `word` is a lowercase letter. */
function startsLower(word: string): boolean {
  const m = /\p{L}/u.exec(word)
  return m !== null && isLower(m[0])
}

/**
 * The token immediately before `index`, lowercased, with any internal periods
 * kept (`e.g`) — what `ABBREVIATIONS` is keyed on.
 */
function tokenBefore(text: string, index: number): string {
  const head = text.slice(0, index)
  const m = /([\p{L}.]+)$/u.exec(head)
  return (m?.[1] ?? "").toLowerCase()
}

/**
 * An ellipsis trails off; it does not end a sentence. A single `…` never
 * matches in the first place (it is not in `TERMINATORS`), so this only has to
 * recognize a run of dots — where the match always anchors on the last one.
 */
function isEllipsis(text: string, terminatorIndex: number): boolean {
  return text[terminatorIndex] === "." && text[terminatorIndex - 1] === "."
}

/**
 * Lowercase where a capital is expected: after sentence-final punctuation, or
 * after a paragraph/heading marker. One span per offending word.
 */
export function findLowercaseStarts(text: string): CapitalizationSpan[] {
  if (!text || !hasCasedLetters(text)) return []
  const out: CapitalizationSpan[] = []

  for (const m of text.matchAll(TERMINATOR_RE)) {
    const word = m[1]
    if (m.index === undefined || !word || !startsLower(word)) continue
    if (isEllipsis(text, m.index)) continue
    // "1. then" is a numbered list, "e.g. the" an abbreviation, "J. smith" an
    // initial — none of them opens a sentence at the following word.
    const before = tokenBefore(text, m.index)
    if (before.length <= 1 || ABBREVIATIONS.has(before)) continue
    const start = m.index + m[0].length - word.length
    out.push({ code: "lowercase-after-terminator", start, end: start + word.length, matchedText: word })
  }

  for (const m of text.matchAll(MARKER_RE)) {
    const word = m[1]
    if (m.index === undefined || !word || !startsLower(word)) continue
    const start = m.index + m[0].length - word.length
    out.push({ code: "lowercase-after-marker", start, end: start + word.length, matchedText: word })
  }

  return out.sort((a, b) => a.start - b.start)
}

/**
 * A word carries a capital after a lowercase letter: `tHe`, `kiSwahili`.
 *
 * A hyphen or apostrophe starts a fresh part of the word, so `Anglo-Saxon`
 * and `O'Brien` are ordinary compounds rather than mixed capitalization —
 * without that reset every hyphenated proper noun in a project would be a
 * finding.
 */
export function isMixedCase(word: string): boolean {
  let seenLower = false
  for (const ch of word) {
    if (ch === "-" || ch === "'" || ch === "’") seenLower = false
    else if (isLower(ch)) seenLower = true
    else if (isUpper(ch) && seenLower) return true
  }
  return false
}

/**
 * The lowercase run a mixed-case form opens with (`"ki"` of `kiSwahili`), or
 * `null` when the form does not start lowercase (`McDonald`). A family of
 * forms sharing a prefix is excepted as one rule rather than one by one.
 */
export function mixedCasePrefix(word: string): string | null {
  const m = /^(\p{Ll}+)\p{Lu}/u.exec(word)
  return m ? m[1] : null
}

/** Every mixed-case word in `text`, with offsets. Caseless text yields none. */
export function findMixedCaseWords(
  text: string,
  exceptions?: ReadonlySet<string>,
): CapitalizationSpan[] {
  if (!text || !hasCasedLetters(text)) return []
  const out: CapitalizationSpan[] = []
  for (const m of text.matchAll(WORD_RE)) {
    const word = m[0]
    if (m.index === undefined || !isMixedCase(word)) continue
    // A USFM marker (`\zaln-s`) is markup, not a word.
    if (text[m.index - 1] === "\\") continue
    if (exceptions?.has(word)) continue
    const prefix = mixedCasePrefix(word)
    if (prefix && exceptions?.has(`${prefix}-`)) continue
    out.push({ code: "mixed-case", start: m.index, end: m.index + word.length, matchedText: word })
  }
  return out
}

export interface CaseExceptionProposal {
  /** The exact form (`kiSwahili`), or `"ki-"` for a whole lowercase-prefix family. */
  form: string
  /** How many occurrences the corpus holds. */
  occurrences: number
  /** For a family proposal, the distinct forms it covers (capped, sorted). */
  examples?: string[]
}

export interface LearnedCaseExceptions {
  /** Forms to skip. A `"<prefix>-"` entry excepts the whole family. */
  exceptions: Set<string>
  /** What was excepted and why, so a human can confirm or reject it. */
  proposals: CaseExceptionProposal[]
}

export interface LearnCaseExceptionOptions {
  /** Occurrences before a form is treated as the project's own word. */
  minOccurrences?: number
  /** Distinct forms before a lowercase prefix is excepted as a family. */
  minFamilyForms?: number
  /** Cap on `CaseExceptionProposal.examples`. */
  maxExamples?: number
}

export const DEFAULT_MIN_OCCURRENCES = 3
export const DEFAULT_MIN_FAMILY_FORMS = 2

/**
 * Learn which mixed-case forms are the project's own vocabulary rather than
 * typos, from how often they occur. Two rules, both frequency-only:
 *
 *  - a form occurring `minOccurrences`+ times is the project's word;
 *  - a lowercase prefix shared by `minFamilyForms`+ distinct forms with
 *    `minOccurrences`+ occurrences between them is a morphological pattern
 *    (noun-class prefixes like `kiSwahili` / `kiNgozi`), so the whole family
 *    is excepted — including a member that occurs once.
 *
 * Forms present in a SOURCE text are excepted outright: a name or brand
 * carried over from the source is not the translator's capitalization.
 */
export function learnCaseExceptions(
  targets: Iterable<string>,
  sources: Iterable<string> = [],
  opts: LearnCaseExceptionOptions = {},
): LearnedCaseExceptions {
  const minOccurrences = opts.minOccurrences ?? DEFAULT_MIN_OCCURRENCES
  const minFamilyForms = opts.minFamilyForms ?? DEFAULT_MIN_FAMILY_FORMS
  const maxExamples = opts.maxExamples ?? 5

  const counts = new Map<string, number>()
  for (const text of targets) {
    for (const span of findMixedCaseWords(text)) {
      counts.set(span.matchedText, (counts.get(span.matchedText) ?? 0) + 1)
    }
  }

  const exceptions = new Set<string>()
  const proposals: CaseExceptionProposal[] = []

  // Source-carried forms: excepted, not proposed — there is nothing to confirm.
  for (const text of sources) {
    for (const span of findMixedCaseWords(text)) exceptions.add(span.matchedText)
  }

  // Families first, so a family member is not also proposed on its own.
  const families = new Map<string, { forms: Map<string, number> }>()
  for (const [form, n] of counts) {
    const prefix = mixedCasePrefix(form)
    if (!prefix) continue
    const fam = families.get(prefix) ?? { forms: new Map() }
    fam.forms.set(form, n)
    families.set(prefix, fam)
  }
  for (const [prefix, fam] of families) {
    const occurrences = [...fam.forms.values()].reduce((a, b) => a + b, 0)
    if (fam.forms.size < minFamilyForms || occurrences < minOccurrences) continue
    exceptions.add(`${prefix}-`)
    proposals.push({
      form: `${prefix}-`,
      occurrences,
      examples: [...fam.forms.keys()].sort().slice(0, maxExamples),
    })
  }

  for (const [form, n] of counts) {
    if (n < minOccurrences || exceptions.has(form)) continue
    const prefix = mixedCasePrefix(form)
    if (prefix && exceptions.has(`${prefix}-`)) continue
    exceptions.add(form)
    proposals.push({ form, occurrences: n })
  }

  proposals.sort((a, b) => b.occurrences - a.occurrences || a.form.localeCompare(b.form))
  return { exceptions, proposals }
}
