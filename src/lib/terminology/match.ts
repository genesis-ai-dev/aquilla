import type { ConceptMatchInput, TermMatchingSettings } from "./model"
import { resolveMatchOptions } from "./match-options"

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
 */
export function conceptToRegexSource(
  concept: ConceptLike,
  project?: TermMatchingSettings,
  opts: ConceptRegexOpts = {},
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
  const re = buildConceptRegex(concept, project, concept.caseSensitive ? "u" : "iu")
  return re !== null && re.test(haystack)
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
  const re = buildConceptRegex(concept, project, concept.caseSensitive ? "gu" : "giu", opts)
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
  return out
}
