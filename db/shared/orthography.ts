// Per-lane orthography transform (AQU-2628).
//
// Uzbekistan adopted a new Latin alphabet on 10 Sept 2026: `sh→ş`, `ch→ç`,
// `oʻ→ö`, `gʻ→ğ`. Biblica ETT starts a Northern Uzbek Bible in the new
// spelling in spring 2027. No corpus exists in it, and every model has read
// millions of pages of the OLD spelling — a 16 Nov 2026 run put the whole
// alphabet rule in `translationInstructions`, confirmed it reached the prompt,
// and the model still returned 175 old-spelling forms across 31 of 31 verses.
// It followed the NAME list in the same prompt, so vocabulary instructions
// work and spelling instructions do not.
//
// So spelling is not a prompt problem. It is a per-lane setting that this one
// function reads, applied at three call sites — import, after AI drafting, and
// (in reverse) on export — plus the `old-orthography` built-in check, which
// judges HUMAN-typed target text by the same config. If that check ever fires
// on an AI draft, the drafting call site is broken.
//
// THREE RULES THAT SHAPE EVERYTHING BELOW:
//
//   1. EMPTY IS OFF. A profile with no `orthography` block converts nothing,
//      flags nothing, and leaves every other project exactly as it was. Every
//      entry point here returns the input unchanged for a null profile.
//
//   2. AN EXCEPTION BEATS A RULE. Uzbek is agglutinative and a handful of
//      words keep `s` and `h` as separate sounds (`Isʼhoq`, `asʼhob`). An
//      exception matches a word that STARTS with it, so `Ishoqning` matches
//      `Isʼhoq`; only `approved` entries affect the converter and the check,
//      so a contributor's proposal is inert until a maintainer approves it.
//
//   3. APOSTROPHES ARE A CLASS, NOT A CHARACTER. People type `'`, `ʻ`, `ʼ`,
//      `‘`, `’`, a grave accent, an acute accent and a prime, and all of them
//      mean the same mark. Any of them directly after `o` or `g` is part of
//      the ö/ğ rule; anywhere else it becomes the profile's canonical mark.
//
// Pure and dependency-free, with no DOM and no relative imports outside this
// folder, so the SPA, auth-worker and sync-worker can all import it — the
// settings-key registry validates agent writes with `orthographyProblem`, and
// the drafting path converts with `convertOrthography`.
//
// Shaped so AQU-1929's transcription orthography profile (character inventory,
// tone marks, normalization) can be added beside `rules`/`apostrophe`/
// `exceptions` later without renaming this slot.
//
// Spec: aquilla-specs 04-features/checks-rules-and-living-memory.md and
// 05-user-stories/run-builtin-check.md (the "Old orthography" guard).

/** Every apostrophe-like mark a person actually types for the same sound. */
export const APOSTROPHE_VARIANTS = "'ʻʼ‘’`´′"

/** U+02BC MODIFIER LETTER APOSTROPHE — the 2026 alphabet's tutuq belgisi. */
export const CANONICAL_APOSTROPHE = "ʼ"

/**
 * U+02BB MODIFIER LETTER TURNED COMMA — the mark the 1995 alphabet used, and
 * the one a legacy export writes back. `oʻ`/`gʻ` are spelled with it.
 */
export const LEGACY_APOSTROPHE = "ʻ"

/** Most rules one profile may list. A longer list is a mistake, not an alphabet. */
export const MAX_ORTHOGRAPHY_RULES = 64

/** Most exceptions one profile may list. */
export const MAX_ORTHOGRAPHY_EXCEPTIONS = 2000

/** Longest a single rule side or exception word may be. */
export const MAX_ORTHOGRAPHY_TOKEN_LENGTH = 32

export const ORTHOGRAPHY_EXCEPTION_STATUSES = ['approved', 'pending'] as const
export type OrthographyExceptionStatus = (typeof ORTHOGRAPHY_EXCEPTION_STATUSES)[number]

/**
 * One word the rules must not touch, in its canonical (converted) spelling.
 * `by` is the user id that proposed or added it and `ref` the place it was
 * found, both carried so the Language profile panel can show who asked for it.
 */
export interface OrthographyException {
  word: string
  status: OrthographyExceptionStatus
  by?: string
  ref?: string
}

/**
 * One lane's orthography. `rules` are ordered and written lowercase; the code
 * derives `Sh→Ş` and `SH→Ş` from `["sh","ş"]`, and matches the longest rule
 * first so a two-character rule can never be shadowed by a one-character one.
 */
export interface OrthographyProfile {
  rules: readonly (readonly [string, string])[]
  /** The canonical apostrophe every variant normalises to. One character. */
  apostrophe: string
  exceptions?: readonly OrthographyException[]
}

/** What one pass changed, for the import preview's "N words converted" line. */
export interface OrthographyConversion {
  text: string
  /** Word tokens a rule rewrote. */
  wordsConverted: number
  /** Word tokens an approved exception protected from a rule. */
  exceptionsApplied: number
}

/** One old-spelling word the check found, with what it should be. */
export interface OrthographyFinding {
  /** Character offset of the word, inclusive. */
  start: number
  /** Character offset past the word, exclusive. */
  end: number
  /** The word as typed. */
  text: string
  /** The same word in the lane's orthography. */
  suggestion: string
}

// ── Shared character classes ──────────────────────────────────────────────

function escapeForClass(chars: string): string {
  return chars.replace(/[\\\]^-]/g, (ch) => `\\${ch}`)
}

const APOSTROPHE_CLASS = `[${escapeForClass(APOSTROPHE_VARIANTS)}]`
const APOSTROPHE_RE = new RegExp(APOSTROPHE_CLASS, 'gu')

/**
 * A word is letters, digits, combining marks and apostrophes. Keeping the
 * apostrophe INSIDE the word is what lets `Is'hoq` match the `Isʼhoq`
 * exception as one token rather than three.
 */
const WORD_RE = new RegExp(`[\\p{L}\\p{N}\\p{M}${escapeForClass(APOSTROPHE_VARIANTS)}]+`, 'gu')

/**
 * Spans the converter copies through untouched, in the order it tries them:
 * a USFM marker (`\v`, `\f*`, `\fr`), an HTML/XML tag, an HTML entity. A cell
 * is markup plus text, and `\ch` is a marker, not the digraph `ch`.
 */
const PROTECTED_RE = /\\[a-zA-Z][a-zA-Z0-9]*\*?|<[^>]*>|&[a-zA-Z#][a-zA-Z0-9]*;/gu

function isApostrophe(char: string): boolean {
  return APOSTROPHE_VARIANTS.includes(char)
}

function stripApostrophes(text: string): string {
  return text.replace(APOSTROPHE_RE, '')
}

/** The comparison form of a word or exception: lowercase, no apostrophes. */
function foldWord(text: string): string {
  return stripApostrophes(text).toLowerCase()
}

// ── Validation ────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ruleSideProblem(value: unknown, where: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return `${where} must be a non-empty string`
  if (value.length > MAX_ORTHOGRAPHY_TOKEN_LENGTH) {
    return `${where} must be at most ${MAX_ORTHOGRAPHY_TOKEN_LENGTH} characters`
  }
  if (/\s/u.test(value)) return `${where} must not contain whitespace`
  return null
}

function exceptionProblem(value: unknown, where: string): string | null {
  if (!isPlainObject(value)) return `${where} must be an object`
  for (const key of Object.keys(value)) {
    if (key !== 'word' && key !== 'status' && key !== 'by' && key !== 'ref') {
      return `${where} has an unknown field "${key}"`
    }
  }
  const wordProblem = ruleSideProblem(value.word, `${where}.word`)
  if (wordProblem) return wordProblem
  if (!(ORTHOGRAPHY_EXCEPTION_STATUSES as readonly unknown[]).includes(value.status)) {
    return `${where}.status must be one of ${ORTHOGRAPHY_EXCEPTION_STATUSES.join(', ')}`
  }
  for (const key of ['by', 'ref'] as const) {
    const field = value[key]
    if (field === undefined) continue
    if (typeof field !== 'string' || field.length > 200) {
      return `${where}.${key} must be a string of at most 200 characters`
    }
  }
  return null
}

/** Null when `value` is a valid orthography block, else what is wrong with it. */
export function orthographyProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'orthography must be an object'
  for (const key of Object.keys(value)) {
    if (key !== 'rules' && key !== 'apostrophe' && key !== 'exceptions') {
      return `orthography has an unknown field "${key}"`
    }
  }
  const { rules, apostrophe, exceptions } = value
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > MAX_ORTHOGRAPHY_RULES) {
    return `orthography.rules must list 1 to ${MAX_ORTHOGRAPHY_RULES} rules`
  }
  for (const [index, rule] of rules.entries()) {
    const where = `orthography.rules[${index}]`
    if (!Array.isArray(rule) || rule.length !== 2) return `${where} must be a [from, to] pair`
    const fromProblem = ruleSideProblem(rule[0], `${where}[0]`)
    if (fromProblem) return fromProblem
    const toProblem = ruleSideProblem(rule[1], `${where}[1]`)
    if (toProblem) return toProblem
    if (typeof rule[0] === 'string' && rule[0] !== rule[0].toLowerCase()) {
      return `${where}[0] must be lowercase — the converter derives the capitalised forms`
    }
  }
  if (typeof apostrophe !== 'string' || Array.from(apostrophe).length !== 1) {
    return 'orthography.apostrophe must be one character'
  }
  if (exceptions !== undefined) {
    if (!Array.isArray(exceptions) || exceptions.length > MAX_ORTHOGRAPHY_EXCEPTIONS) {
      return `orthography.exceptions must list at most ${MAX_ORTHOGRAPHY_EXCEPTIONS} words`
    }
    for (const [index, entry] of exceptions.entries()) {
      const problem = exceptionProblem(entry, `orthography.exceptions[${index}]`)
      if (problem) return problem
    }
  }
  return null
}

/** Shown by describe_command("PatchSettings") and in validation errors. */
export const ORTHOGRAPHY_TYPE_NAME =
  '{ rules: [from, to][] (lowercase "from"), apostrophe: string (one character), ' +
  'exceptions?: { word: string, status: "approved" | "pending", by?: string, ref?: string }[] }'

/** True when this profile has something to do. An absent block is simply off. */
export function hasOrthography(profile: OrthographyProfile | null | undefined): profile is OrthographyProfile {
  return !!profile && profile.rules.length > 0
}

/** The exceptions that affect the converter and the check — approved ones only. */
export function approvedExceptions(profile: OrthographyProfile | null | undefined): OrthographyException[] {
  return (profile?.exceptions ?? []).filter((entry) => entry.status === 'approved')
}

// ── The compiled form the converter actually runs ─────────────────────────

interface CompiledRule {
  /** Matches `from` case-insensitively, with any apostrophe variant. */
  match: RegExp
  to: string
}

interface CompiledOrthography {
  rules: CompiledRule[]
  apostrophe: string
  /** Approved exceptions, longest fold first so the most specific one wins. */
  exceptions: { fold: string; word: string }[]
}

/** `from` as a sticky regex: case-insensitive, apostrophe-variant tolerant. */
function ruleMatcher(from: string): RegExp {
  const pattern = Array.from(from)
    .map((char) => (isApostrophe(char) ? APOSTROPHE_CLASS : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(pattern, 'iuy')
}

/**
 * One compiled profile per (profile object, direction). The rule set is
 * stamped onto every built-in rule once (`resolveBuiltinRules`) and reused
 * across every cell, so the same object arrives here thousands of times —
 * recompiling four regexes per cell of a Bible is work nobody asked for. A
 * WeakMap because the entry should die with the profile it describes.
 */
const COMPILED = new WeakMap<OrthographyProfile, Partial<Record<'canonical' | 'legacy', CompiledOrthography>>>()

function compiled(profile: OrthographyProfile, direction: 'canonical' | 'legacy'): CompiledOrthography {
  const byDirection = COMPILED.get(profile) ?? {}
  const hit = byDirection[direction]
  if (hit) return hit
  const built = compile(profile, direction)
  COMPILED.set(profile, { ...byDirection, [direction]: built })
  return built
}

function compile(profile: OrthographyProfile, direction: 'canonical' | 'legacy'): CompiledOrthography {
  const pairs: (readonly [string, string])[] =
    direction === 'canonical'
      ? profile.rules.map((rule) => [rule[0], rule[1]] as const)
      : // A legacy export writes the OLD spelling, and spells it with the mark
        // the old alphabet used, whichever variant the rule was stored with.
        profile.rules.map((rule) => [rule[1], rule[0].replace(APOSTROPHE_RE, LEGACY_APOSTROPHE)] as const)
  // Longest first: a one-character rule must never shadow a two-character one.
  const ordered = [...pairs].sort((a, b) => b[0].length - a[0].length)
  return {
    rules: ordered.map(([from, to]) => ({ match: ruleMatcher(from), to })),
    apostrophe: direction === 'canonical' ? profile.apostrophe : LEGACY_APOSTROPHE,
    exceptions: approvedExceptions(profile)
      .map((entry) => ({ fold: foldWord(entry.word), word: entry.word }))
      .filter((entry) => entry.fold.length > 0)
      .sort((a, b) => b.fold.length - a.fold.length),
  }
}

/** `to`, recased to match how `matched` was written. */
function recase(matched: string, to: string): string {
  const cased = Array.from(matched).filter((char) => char.toLowerCase() !== char.toUpperCase())
  if (cased.length === 0) return to
  const allUpper = cased.every((char) => char === char.toUpperCase())
  if (allUpper && cased.length > 1) return to.toUpperCase()
  if (cased[0] === cased[0].toUpperCase()) return to.charAt(0).toUpperCase() + to.slice(1)
  return to
}

/**
 * Apply the rules (and the apostrophe normalisation) to a run of text.
 *
 * `ruleMatched` deliberately excludes a bare apostrophe normalisation: tidying
 * the mark a keyboard typed is not an old-spelling finding, so the check must
 * be able to tell the two apart (see {@link findOldOrthography}).
 */
function applyRules(text: string, compiled: CompiledOrthography): { text: string; ruleMatched: boolean } {
  let out = ''
  let ruleMatched = false
  let index = 0
  while (index < text.length) {
    let matched = false
    for (const rule of compiled.rules) {
      rule.match.lastIndex = index
      const hit = rule.match.exec(text)
      if (!hit) continue
      out += recase(hit[0], rule.to)
      index += hit[0].length
      matched = true
      ruleMatched = true
      break
    }
    if (matched) continue
    const char = text.charAt(index)
    out += isApostrophe(char) ? compiled.apostrophe : char
    index += 1
  }
  return { text: out, ruleMatched }
}

/**
 * Render an exception's canonical spelling with the capitalisation the writer
 * used: `ISHOQ` keeps its capitals as `ISʼHOQ`, `Is'hoq` keeps its one as
 * `Isʼhoq`, and the apostrophe becomes the profile's canonical mark.
 *
 * Returns how far into `word` the exception reached, so the suffix after it
 * (`-ning` on `Ishoqning`) still goes through the rules.
 */
function renderException(
  word: string,
  exception: { fold: string; word: string },
  apostrophe: string,
): { text: string; consumed: number } {
  const letters: string[] = []
  let consumed = 0
  for (const char of Array.from(word)) {
    consumed += char.length
    if (isApostrophe(char)) continue
    letters.push(char)
    if (letters.length === exception.fold.length) break
  }
  let letterIndex = 0
  let text = ''
  for (const char of Array.from(exception.word)) {
    if (isApostrophe(char)) {
      text += apostrophe
      continue
    }
    const source = letters[letterIndex]
    letterIndex += 1
    text += source !== undefined && source === source.toUpperCase() && source !== source.toLowerCase()
      ? char.toUpperCase()
      : char.toLowerCase()
  }
  return { text, consumed }
}

interface WordResult {
  text: string
  ruleApplied: boolean
  exceptionApplied: boolean
}

function convertWord(word: string, compiled: CompiledOrthography): WordResult {
  const fold = foldWord(word)
  for (const exception of compiled.exceptions) {
    if (!fold.startsWith(exception.fold)) continue
    const rendered = renderException(word, exception, compiled.apostrophe)
    const suffix = applyRules(word.slice(rendered.consumed), compiled)
    return { text: rendered.text + suffix.text, ruleApplied: false, exceptionApplied: true }
  }
  const converted = applyRules(word, compiled)
  return { text: converted.text, ruleApplied: converted.ruleMatched, exceptionApplied: false }
}

/**
 * Walk `text` word by word, leaving markup alone. `onWord` decides what each
 * word becomes; everything between words is copied through unchanged except
 * for stray apostrophes, which become the canonical mark.
 */
function walkWords(
  text: string,
  compiled: CompiledOrthography,
  onWord: (word: string, start: number) => string,
): string {
  let out = ''
  let cursor = 0
  PROTECTED_RE.lastIndex = 0
  const protectedSpans: { start: number; end: number }[] = []
  for (const match of text.matchAll(PROTECTED_RE)) {
    protectedSpans.push({ start: match.index, end: match.index + match[0].length })
  }
  const isProtected = (start: number, end: number): boolean =>
    protectedSpans.some((span) => start < span.end && end > span.start)

  WORD_RE.lastIndex = 0
  for (const match of text.matchAll(WORD_RE)) {
    const start = match.index
    const end = start + match[0].length
    if (isProtected(start, end)) continue
    out += text.slice(cursor, start).replace(APOSTROPHE_RE, compiled.apostrophe)
    out += onWord(match[0], start)
    cursor = end
  }
  out += text.slice(cursor).replace(APOSTROPHE_RE, compiled.apostrophe)
  return out
}

/**
 * The lane's orthography applied to `text`. A null or empty profile returns
 * the text unchanged, which is what every project without the block gets.
 *
 * `direction: 'legacy'` runs the rules backwards for the legacy export: the
 * new letters become the old digraphs, spelled with the old apostrophe.
 */
export function convertOrthography(
  text: string,
  profile: OrthographyProfile | null | undefined,
  options?: { direction?: 'canonical' | 'legacy' },
): OrthographyConversion {
  if (!hasOrthography(profile) || text.length === 0) {
    return { text, wordsConverted: 0, exceptionsApplied: 0 }
  }
  const rules = compiled(profile, options?.direction ?? 'canonical')
  let wordsConverted = 0
  let exceptionsApplied = 0
  const out = walkWords(text, rules, (word) => {
    const result = convertWord(word, rules)
    if (result.ruleApplied) wordsConverted += 1
    if (result.exceptionApplied) exceptionsApplied += 1
    return result.text
  })
  return { text: out, wordsConverted, exceptionsApplied }
}

/** Shorthand for the call sites that only want the converted string. */
export function convertOrthographyText(
  text: string,
  profile: OrthographyProfile | null | undefined,
  direction: 'canonical' | 'legacy' = 'canonical',
): string {
  return convertOrthography(text, profile, { direction }).text
}

/**
 * Every word in `text` still written in the old orthography, with what the
 * lane's rules would make of it. An approved exception never appears here —
 * that is the whole point of approving one.
 *
 * Only a RULE match is a finding. An apostrophe variant on its own is a
 * typographic nicety the converter tidies but the check stays quiet about,
 * so a translator is never underlined for the apostrophe their keyboard types.
 */
export function findOldOrthography(
  text: string,
  profile: OrthographyProfile | null | undefined,
): OrthographyFinding[] {
  if (!hasOrthography(profile) || text.length === 0) return []
  const rules = compiled(profile, 'canonical')
  const findings: OrthographyFinding[] = []
  walkWords(text, rules, (word, start) => {
    const result = convertWord(word, rules)
    if (result.ruleApplied) {
      findings.push({ start, end: start + word.length, text: word, suggestion: result.text })
    }
    return word
  })
  return findings
}
