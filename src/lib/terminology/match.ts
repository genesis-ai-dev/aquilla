import type { ConceptMatchInput, TermMatchingSettings } from "./model"
import { resolveMatchOptions } from "./match-options"
import {
  AnchorIndex,
  mayMatch,
  prefilterForTerms,
  prefilterMode,
  verifyRejected,
  type Prefilter,
} from "./prefilter"

/**
 * Shared terminology matcher — inflectional wildcard support.
 *
 * Terminology text (source terms and renderings) is matched everywhere with the
 * SAME semantics so enforcement rules, pre-acceptance warnings, editor chips,
 * per-term occurrences and managed-candidate exclusion all agree.
 *
 * Wildcard semantics
 * ------------------
 * A literal `*` in a user term is a wildcard standing for an inflectional run of
 * letters. We expand it to `[\p{L}\p{M}]*` — zero-or-more Unicode *letters or
 * combining marks*. Marks are included because a wildcard stands for "the rest
 * of the word", and in scripts with combining diacritics (Hebrew vowel points,
 * accents, …) an inflected/pointed word is letters interleaved with marks; a
 * letters-only wildcard would stop at the first mark.
 *
 *   - `\p{L}` (Unicode letter) is chosen over `\w` deliberately:
 *       · `\w` is ASCII-only ([A-Za-z0-9_]) and would NOT match accented /
 *         non-Latin inflections (gracia's "í", Greek, Cyrillic, …) — the whole
 *         point of this feature is cross-script inflection.
 *       · `\w` also matches digits and `_`, which are not inflectional letters.
 *     `\p{L}` (with the `u` flag) matches a letter in any script and nothing
 *     else, which is exactly "an inflectional run".
 *
 * Mark folding
 * ------------
 * `foldMarks: true` makes matching tolerant of diacritics (Hebrew vowel
 * points/accents, Greek accents, Latin diacritics, …) so a term selected under
 * one pointing matches the same letters under different or no pointing. Folding
 * is done INSIDE the regex, not by stripping the haystack first: `literalSegment`
 * strips marks from the term's literal segments, then re-inserts `\p{M}*`
 * after every remaining character, so the compiled pattern still walks the
 * original (pointed) haystack and reported match offsets/spans stay correct
 * for consumers like editor decorations.
 *
 * Unicode stores the same diacritic two ways, and folding has to cover both
 * (AQU-1936). Hebrew/Arabic/Syriac points stay separate combining marks under
 * NFC, so `\p{M}*` finds them. Greek accents and Latin diacritics COMPOSE under
 * NFC into one precomposed code point — καὶ is κ, α, U+1F76, with no mark in
 * sight — so `\p{M}*` can never see them, and a folded term matched neither the
 * other accent nor its own spelling. `foldedChar` therefore emits, for each
 * stripped base letter, a class of that letter plus every precomposed form of
 * it, so one folded pattern spans both encodings at the original offsets.
 *
 * Word boundaries
 * ---------------
 * `\b` is ASCII-centric, so we use letter-class lookarounds instead:
 *   - leading boundary  → `(?<![\p{L}\p{M}])`  (not preceded by a letter or mark)
 *   - trailing boundary → `(?![\p{L}\p{M}])`   (not followed by a letter or mark)
 * Marks are included in the boundary class because a combining mark (a vowel
 * point, accent, diacritic, …) is word-internal, not a separator: with
 * mark-folding on, a plain `(?<!\p{L})` only inspects the single adjacent code
 * point, so a real preceding consonant separated from the term by just a mark
 * (e.g. a sheva) would be missed and the boundary would incorrectly fire mid-word.
 * A term WITHOUT a leading `*` gets a leading boundary; WITHOUT a trailing `*`
 * gets a trailing boundary. A term WITH a trailing `*` ends in `\p{L}*` and gets
 * NO trailing boundary, so the inflectional suffix is consumed greedily.
 *
 * Backward compatibility: a term with NO `*` becomes
 * `(?<![\p{L}\p{M}])escaped(?![\p{L}\p{M}])` — i.e. exact whole-word,
 * case-insensitive, Unicode-aware matching, a strict superset of the old
 * `\b…\b` behaviour for the cases the app cares about (whole-word, alphabetic
 * terms).
 *
 * Regex-injection safety: every non-`*` character is regex-escaped, so a term
 * like `a.b` matches the literal text "a.b", never "axb".
 */

/** Escape a string for safe literal use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const LEAD_BOUNDARY = "(?<![\\p{L}\\p{M}])"
const TRAIL_BOUNDARY = "(?![\\p{L}\\p{M}])"
/** A wildcard `*` expands to the rest of an inflected word: letters AND marks. */
const WILDCARD = "[\\p{L}\\p{M}]*"
/** Zero-or-more combining marks; interleaved after every literal char when folding. */
const MARKS = "\\p{M}*"

export interface TermRegexOptions {
  /** Ignore combining marks on both sides (see file header). */
  foldMarks?: boolean
  /** Project affix inventory; only used when non-empty. */
  prefixes?: string[]
  suffixes?: string[]
  /** Chained affixes allowed per side (default 2). */
  maxAffixes?: number
}

/** NFD, drop every combining mark, NFC. */
export function stripMarks(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").normalize("NFC")
}

/** Code points once combining marks are gone — an affix's length in letters. */
function letterLength(s: string): number {
  return Array.from(stripMarks(s)).length
}

/**
 * Code-point ranges scanned to build the precomposed-form index. Every block
 * that holds canonically precomposed LETTERS and nothing we would have to
 * reason about reordering for: Latin-1 Supplement + Latin Extended-A/B, Greek
 * with tonos/dialytika, Cyrillic, then Latin Extended Additional and Greek
 * Extended (the polytonic block, where καὶ's U+1F76 lives). Indic blocks are
 * deliberately out: their canonical compositions are not a letter-plus-accent
 * story and folding them is a separate decision.
 */
const PRECOMPOSED_SCAN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00c0, 0x024f],
  [0x0386, 0x03ce],
  [0x0400, 0x04ff],
  [0x1e00, 0x1fff],
]

/** base letter → every precomposed code point that folds down to it. */
let precomposedByBase: Map<string, string[]> | null = null

/**
 * AQU-1936: the precomposed forms of one base letter — ι → ί ὶ ῖ ΐ ῒ …
 *
 * Built by inverting NFD over the ranges above rather than from a hand-written
 * table, so it cannot drift from what `stripMarks` actually produces. Built
 * once, lazily, and only when something folds: a term with no folding compiles
 * exactly as it did before and pays nothing.
 */
function precomposedVariants(base: string): readonly string[] {
  if (precomposedByBase === null) {
    const map = new Map<string, string[]>()
    for (const [from, to] of PRECOMPOSED_SCAN_RANGES) {
      for (let cp = from; cp <= to; cp += 1) {
        const ch = String.fromCodePoint(cp)
        // Only forms real NFC text can contain: a code point NFC would itself
        // rewrite can never appear in a normalized haystack.
        if (ch.normalize("NFC") !== ch) continue
        const stripped = stripMarks(ch)
        // One base letter, and actually accented — skips unaccented letters
        // and the ligatures/singletons that strip to several characters.
        if (stripped.length !== 1 || stripped === ch) continue
        const list = map.get(stripped)
        if (list) list.push(ch)
        else map.set(stripped, [ch])
      }
    }
    precomposedByBase = map
  }
  return precomposedByBase.get(base) ?? []
}

/**
 * One folded base letter: a class of the letter plus every precomposed form of
 * it, so the pattern matches whether the haystack spells the accent as a
 * combining mark (covered by the following `\p{M}*`) or composed into the
 * letter. Falls back to the bare escaped character when the letter has no
 * precomposed forms, so punctuation and unaccentable scripts compile byte-for-
 * byte as before.
 */
function foldedChar(ch: string): string {
  const variants = precomposedVariants(ch)
  if (variants.length === 0) return escapeRegex(ch)
  return `[${escapeRegex(ch)}${variants.map((v) => escapeRegex(v)).join("")}]`
}

/**
 * Escape a literal segment for the regex. When folding, marks are removed from
 * the segment and each remaining character becomes `foldedChar` + `\p{M}*`, so
 * the pattern matches the pointed or accented original at its true offsets.
 */
function literalSegment(seg: string, foldMarks: boolean): string {
  if (!foldMarks) return escapeRegex(seg)
  return Array.from(stripMarks(seg))
    .map((ch) => foldedChar(ch) + MARKS)
    .join("")
}

/**
 * Convert a user term into a regex source string with inflectional wildcard,
 * word-boundary, optional mark-folding and optional affix semantics.
 * Returns `null` for empty / whitespace-only terms (nothing to match).
 */
export function termToRegexSource(term: string, opts: TermRegexOptions = {}): string | null {
  const trimmed = term.trim()
  if (!trimmed) return null
  const fold = opts.foldMarks === true

  const hasLeadingStar = trimmed.startsWith("*")
  const hasTrailingStar = trimmed.endsWith("*")

  const body = trimmed
    .split("*")
    .map((seg) => literalSegment(seg, fold))
    .join(WILDCARD)

  const lead = hasLeadingStar ? "" : LEAD_BOUNDARY + affixGroup(opts.prefixes, opts.maxAffixes, fold, "prefix")
  const trail = hasTrailingStar ? "" : affixGroup(opts.suffixes, opts.maxAffixes, fold, "suffix") + TRAIL_BOUNDARY
  return `${lead}${body}${trail}`
}

/**
 * Bounded alternation of affixes. Returns "" when the list is empty so a term
 * with no inventory compiles exactly as before. Longest first so `ים` is
 * preferred over `י` when both could match.
 *
 * "Longest" is counted on the MARK-STRIPPED string (AQU-1272). Raw `.length`
 * counts combining marks, so a one-letter affix carrying a vowel point and an
 * accent (3 code points) sorted ahead of a genuinely two-letter one — and since
 * the alternation is ordered, the regex would then prefer the shorter affix.
 * Letters are what an affix is; the marks on them are not part of its length.
 */
function affixGroup(
  affixes: string[] | undefined,
  maxAffixes: number | undefined,
  fold: boolean,
  side: "prefix" | "suffix",
): string {
  const list = (affixes ?? []).map((a) => a.trim()).filter((a) => a.length > 0)
  if (list.length === 0) return ""
  // Dedupe and drop empties AFTER folding, not before: folding collapses
  // differently-pointed spellings of one affix onto the same pattern (ים/יִם),
  // and a mark-only affix folds away to nothing — an empty alternative would
  // make the group match the empty string everywhere.
  const folded = [...new Set(list)]
    .sort((a, b) => letterLength(b) - letterLength(a) || b.length - a.length)
    .map((a) => literalSegment(a, fold))
  const alts = [...new Set(folded)].filter((p) => p.length > 0).join("|")
  if (alts.length === 0) return ""
  const n = Math.max(1, Math.min(maxAffixes ?? 2, 4))
  // A prefix is followed by the marks that sit on its last letter; a suffix is
  // preceded by the marks sitting on the stem's last letter. When folding the
  // literalSegment already emits trailing \p{M}*, so only the suffix side needs
  // the leading run.
  return side === "prefix" ? `(?:(?:${alts})${fold ? "" : MARKS}){0,${n}}` : `(?:${MARKS}(?:${alts})){0,${n}}`
}

/**
 * Build a RegExp for a term. Returns `null` for empty/whitespace terms.
 * Default flags: case-insensitive + Unicode. Add `g` for global scanning.
 */
export function buildTermRegex(term: string, flags = "iu", opts?: TermRegexOptions): RegExp | null {
  const src = termToRegexSource(term, opts)
  if (src === null) return null
  return new RegExp(src, flags)
}

/** True if `haystack` contains a match for `term` (Unicode; case-insensitive unless asked). */
export function matchesTerm(
  haystack: string,
  term: string,
  opts?: { caseSensitive?: boolean } & TermRegexOptions,
): boolean {
  if (!haystack) return false
  const flags = opts?.caseSensitive ? "u" : "iu"
  const re = buildTermRegex(term, flags, opts)
  return re !== null && re.test(haystack)
}

type ConceptLike = ConceptMatchInput

export interface ConceptRegexOpts {
  /** Skip the exclusion lookahead so excluded surface forms still match. */
  includeExcluded?: boolean
}

/**
 * One regex source for a whole concept: sourceTerm + match.forms as
 * alternates, each with boundaries and affix groups; excludedForms as a
 * leading negative lookahead anchored at the same word start.
 *
 * Memoized per concept object, and behind that per content (AQU-2654). Building this source walks every
 * character of every form through escaping, mark folding and affix expansion.
 * Callers ask for it once per concept per text they test, and the editor asks
 * from render, so an uncached build made a 664-term glossary cost seconds per
 * row render. The entry is checked against the fields it was built from, so a
 * concept edited in place is rebuilt rather than served stale.
 */
export function conceptToRegexSource(
  concept: ConceptLike,
  project?: TermMatchingSettings,
  opts: ConceptRegexOpts = {},
): string | null {
  const cached = compiledFor(concept, project)
  const includeExcluded = !!opts.includeExcluded
  const hit = includeExcluded ? cached.withExcluded : cached.source
  if (hit !== undefined) return hit
  const built = buildConceptRegexSource(concept, project, opts)
  if (includeExcluded) cached.withExcluded = built
  else cached.source = built
  if (built !== null) prefilterByPattern.set(built, conceptPrefilter(concept, project))
  return built
}

function buildConceptRegexSource(
  concept: ConceptLike,
  project: TermMatchingSettings | undefined,
  opts: ConceptRegexOpts,
): string | null {
  const r = resolveMatchOptions(concept, project)
  const termOpts: TermRegexOptions = {
    foldMarks: r.foldMarks,
    ...(r.affixes ? { prefixes: r.prefixes, suffixes: r.suffixes, maxAffixes: r.maxAffixes } : {}),
  }
  const alts = [concept.sourceTerm, ...r.forms]
    .map((t) => termToRegexSource(t, termOpts))
    .filter((p): p is string => p !== null)
  if (alts.length === 0) return null
  const body = alts.length === 1 ? alts[0] : `(?:${alts.join("|")})`

  if (opts.includeExcluded || r.excludedForms.length === 0) return body
  const excl = r.excludedForms
    .map((f) => literalSegment(f, r.foldMarks))
    .join("|")
  // Anchored where the match would start: not adjacent to a letter or
  // combining mark (the same boundary class the term alternates use), and the
  // excluded surface must end at a word boundary so `הארץ` excludes only the
  // whole word, never a longer word that begins with it.
  return `(?!(?:${excl})${TRAIL_BOUNDARY})${body}`
}

interface CompiledConcept {
  /** `undefined` = not built yet; `null` = the concept has no usable term. */
  source?: string | null
  withExcluded?: string | null
  /** What a text must contain for either source to be able to match it. */
  prefilter?: Prefilter
}

interface ConceptCacheEntry {
  /** The fields the entry was built from — a mismatch means rebuild. */
  sourceTerm: string
  match: ConceptLike["match"]
  compiled: CompiledConcept
}

const compiledConcepts = new WeakMap<object, Map<string, ConceptCacheEntry>>()
/**
 * The same entries by CONTENT. The editor does not hold on to concept objects:
 * the lane filter copies every concept when its inputs are re-read, and
 * `compileConceptsToRulesCore` passes a fresh `{ sourceTerm, match }`. Without
 * this second key each of those would build every pattern again, and — since
 * the compiled regexes hang off the pattern string — hand back an equal but
 * different string object, which costs the regex cache a full string compare
 * per lookup instead of a pointer compare.
 */
const compiledByContent = new Map<string, CompiledConcept>()
const MAX_COMPILED_BY_CONTENT = 20000
const settingsKeys = new WeakMap<object, string>()

/**
 * A cache key for the project's matching settings, by content. Callers build
 * the settings object in render, so its identity changes while its content
 * does not; keying on identity would miss every time.
 */
export function termMatchingKey(project?: TermMatchingSettings): string {
  if (!project) return ""
  let key = settingsKeys.get(project)
  if (key === undefined) {
    key = JSON.stringify([project.prefixes, project.suffixes, project.maxAffixes ?? null, project.foldMarksDefault ?? null])
    settingsKeys.set(project, key)
  }
  return key
}

function compiledFor(concept: ConceptLike, project?: TermMatchingSettings): CompiledConcept {
  let byProject = compiledConcepts.get(concept)
  if (!byProject) {
    byProject = new Map()
    compiledConcepts.set(concept, byProject)
  }
  const key = termMatchingKey(project)
  let entry = byProject.get(key)
  if (!entry || entry.sourceTerm !== concept.sourceTerm || entry.match !== concept.match) {
    const contentKey = `${key}\u0001${concept.sourceTerm}\u0001${JSON.stringify(concept.match ?? null)}`
    let compiled = compiledByContent.get(contentKey)
    if (!compiled) {
      compiled = {}
      if (compiledByContent.size >= MAX_COMPILED_BY_CONTENT) compiledByContent.clear()
      compiledByContent.set(contentKey, compiled)
    }
    entry = { sourceTerm: concept.sourceTerm, match: concept.match, compiled }
    byProject.set(key, entry)
  }
  return entry.compiled
}

/**
 * What a text must contain for the concept to be able to match it — see
 * ./prefilter for why this is a superset of what the regex matches. Built from
 * the same alternates `buildConceptRegexSource` compiles: the headword and the
 * listed forms that are not blank. Affixes, boundaries and exclusions only
 * surround or narrow a match, so they take no part.
 */
export function conceptPrefilter(concept: ConceptLike, project?: TermMatchingSettings): Prefilter {
  const cached = compiledFor(concept, project)
  if (!cached.prefilter) {
    const alternates = [concept.sourceTerm, ...resolveMatchOptions(concept, project).forms].filter(
      (term) => term.trim().length > 0,
    )
    cached.prefilter = prefilterForTerms(alternates)
  }
  return cached.prefilter
}

/** pattern → what a text must contain for it to match, for the rule engine. */
const prefilterByPattern = new Map<string, Prefilter>()

/**
 * The prefilter of a pattern this module built for a concept, or `undefined`
 * for any other string. The rule engine holds terminology as compiled rules —
 * a pattern, not a concept — and asks by the pattern itself, so the answer can
 * only ever be the one derived for exactly that regex.
 */
export function prefilterForPattern(pattern: string): Prefilter | undefined {
  return prefilterByPattern.get(pattern)
}

const compiledPatterns = new Map<string, Map<string, RegExp | null>>()
let patternsCompiled = 0

/**
 * One compiled RegExp per (pattern, flags) for the whole app (AQU-2654). The
 * matcher and the rule engine test the same concept patterns; with a cache
 * each, every pattern was parsed and — the expensive part — compiled by V8 on
 * its first exec, once per cache. Keyed by the pattern string first, so a
 * lookup with the cached string object is a pointer compare rather than a
 * hash of a multi-kilobyte key. `null` is a pattern that does not compile.
 *
 * A `g` regex carries `lastIndex`: callers reset it before use and never hold
 * the regex across an await.
 */
export function compiledPattern(pattern: string, flags: string): RegExp | null {
  let byFlags = compiledPatterns.get(pattern)
  if (!byFlags) {
    byFlags = new Map()
    compiledPatterns.set(pattern, byFlags)
  }
  let re = byFlags.get(flags)
  if (re === undefined) {
    try {
      re = new RegExp(pattern, flags)
    } catch {
      re = null
    }
    patternsCompiled += 1
    byFlags.set(flags, re)
  }
  return re
}

/** How many distinct (pattern, flags) have been compiled — for tests that count work. */
export function compiledPatternCount(): number {
  return patternsCompiled
}

/**
 * The cached compiled regex, always global so the matcher's two questions
 * ("does it match", "where") and the rule engine share one. It is only handed
 * to the synchronous loops below, which reset `lastIndex` first; exported
 * callers of `buildConceptRegex` still get a regex of their own.
 */
function sharedConceptRegex(
  concept: ConceptLike,
  project: TermMatchingSettings | undefined,
  opts?: ConceptRegexOpts,
): RegExp | null {
  const src = conceptToRegexSource(concept, project, opts)
  if (src === null) return null
  const re = compiledPattern(src, concept.caseSensitive ? "gu" : "giu")
  if (re) re.lastIndex = 0
  return re
}

/** True when the prefilter says the concept cannot match `haystack`. */
function ruledOut(
  haystack: string,
  concept: ConceptLike,
  project: TermMatchingSettings | undefined,
  opts?: ConceptRegexOpts,
): boolean {
  if (mayMatch(conceptPrefilter(concept, project), haystack)) return false
  if (prefilterMode() === "verify") {
    const src = conceptToRegexSource(concept, project, opts)
    if (src !== null) verifyRejected(src, concept.caseSensitive ? "u" : "iu", haystack)
  }
  return true
}

export function buildConceptRegex(
  concept: ConceptLike,
  project?: TermMatchingSettings,
  flags = "iu",
  opts?: ConceptRegexOpts,
): RegExp | null {
  const src = conceptToRegexSource(concept, project, opts)
  return src === null ? null : new RegExp(src, flags)
}

export function matchesConcept(haystack: string, concept: ConceptLike, project?: TermMatchingSettings): boolean {
  if (!haystack) return false
  if (ruledOut(haystack, concept, project)) return false
  const re = sharedConceptRegex(concept, project)
  if (re === null) return false
  const hit = re.test(haystack)
  re.lastIndex = 0
  return hit
}

interface ConceptIndex {
  index: AnchorIndex
  /** Per text: the concepts that may match it, in the array's order. */
  byText: Map<string, readonly unknown[]>
}

const conceptIndexes = new WeakMap<readonly object[], Map<string, ConceptIndex>>()
const MAX_CANDIDATE_TEXTS = 4096

/**
 * The concepts of `concepts` that may match `haystack`, in the order given:
 * every concept `matchesConcept` accepts is among them, and for a glossary
 * that mostly does not occur in the text, little else. One pass over the text
 * instead of one test per concept — this is what a caller that would loop
 * over the whole glossary per row, per keystroke or per cell loops over
 * instead. The verdict is still `matchesConcept` / `findConceptMatches`.
 *
 * The index is built once per termbase array (and settings), so the array
 * must be replaced, not edited in place, when a term changes — the contract
 * `conceptsForSourceSurface` already relies on. The returned array is shared:
 * do not mutate it.
 */
export function candidateConcepts<T extends ConceptLike>(
  haystack: string,
  concepts: readonly T[],
  project?: TermMatchingSettings,
): readonly T[] {
  if (!haystack || concepts.length === 0) return []
  if (prefilterMode() === "off") return concepts
  let byProject = conceptIndexes.get(concepts)
  if (!byProject) {
    byProject = new Map()
    conceptIndexes.set(concepts, byProject)
  }
  const key = termMatchingKey(project)
  let entry = byProject.get(key)
  if (!entry) {
    const index = new AnchorIndex()
    concepts.forEach((concept, i) => index.add(i, conceptPrefilter(concept, project)))
    entry = { index, byText: new Map() }
    byProject.set(key, entry)
  }
  let found = entry.byText.get(haystack) as readonly T[] | undefined
  if (!found) {
    found = entry.index.candidates(haystack).map((i) => concepts[i])
    if (entry.byText.size >= MAX_CANDIDATE_TEXTS) entry.byText.clear()
    entry.byText.set(haystack, found)
  }
  return found
}

export interface ConceptMatch {
  start: number
  end: number
  surface: string
}

/** Every non-overlapping match with [start,end) offsets in the ORIGINAL text. */
export function findConceptMatches(
  haystack: string,
  concept: ConceptLike,
  project?: TermMatchingSettings,
  opts?: ConceptRegexOpts,
): ConceptMatch[] {
  if (!haystack) return []
  if (ruledOut(haystack, concept, project, opts)) return []
  const re = sharedConceptRegex(concept, project, opts)
  if (!re) return []
  const out: ConceptMatch[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(haystack)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1
      continue
    }
    out.push({ start: m.index, end: m.index + m[0].length, surface: m[0] })
  }
  re.lastIndex = 0
  return out
}

interface PlainTerm {
  source: string
  prefilter: Prefilter
}

const plainTerms = new Map<string, PlainTerm | null>()
const MAX_PLAIN_TERMS = 20000

/** A term with no match options (a rendering): its pattern and prefilter, cached by the term. */
function plainTerm(term: string): PlainTerm | null {
  let entry = plainTerms.get(term)
  if (entry === undefined) {
    const source = termToRegexSource(term)
    entry = source === null ? null : { source, prefilter: prefilterForTerms([term]) }
    if (plainTerms.size >= MAX_PLAIN_TERMS) plainTerms.clear()
    plainTerms.set(term, entry)
  }
  return entry
}

/**
 * Every non-overlapping, case-insensitive match of a plain term (wildcards and
 * word boundaries, no match options) — what `buildTermRegex(term, "giu")` and
 * an exec loop find, without building a regex per call: the pattern is cached
 * by the term, compiled once, and not run at all on a text the prefilter rules
 * out. The target column asks this for every approved rendering of every
 * concept, for every row.
 */
export function findPlainTermMatches(text: string, term: string): Array<{ start: number; end: number }> {
  if (!term || !text) return []
  const entry = plainTerm(term)
  if (!entry) return []
  if (!mayMatch(entry.prefilter, text)) {
    verifyRejected(entry.source, "iu", text)
    return []
  }
  const re = compiledPattern(entry.source, "giu")
  if (!re) return []
  re.lastIndex = 0
  const out: Array<{ start: number; end: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    // Zero-width matches (a term that is only `*`) would loop forever.
    if (m[0].length === 0) {
      re.lastIndex += 1
      continue
    }
    out.push({ start: m.index, end: m.index + m[0].length })
  }
  re.lastIndex = 0
  return out
}
