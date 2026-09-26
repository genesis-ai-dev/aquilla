import type { Concept, TermMatchingSettings } from "./types"
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
 * `foldMarks: true` makes matching tolerant of combining marks (Hebrew vowel
 * points/accents, Latin diacritics, …) so a term selected under one pointing
 * matches the same consonants under different or no pointing. Folding is done
 * INSIDE the regex, not by stripping the haystack first: `literalSegment`
 * strips marks from the term's literal segments, then re-inserts `\p{M}*`
 * after every remaining character, so the compiled pattern still walks the
 * original (pointed) haystack and reported match offsets/spans stay correct
 * for consumers like editor decorations.
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

/**
 * Escape a literal segment for the regex. When folding, marks are removed from
 * the segment and `\p{M}*` is emitted after every remaining character, so the
 * pattern matches the pointed original at its true offsets.
 */
function literalSegment(seg: string, foldMarks: boolean): string {
  if (!foldMarks) return escapeRegex(seg)
  return Array.from(stripMarks(seg))
    .map((ch) => escapeRegex(ch) + MARKS)
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
    .sort((a, b) => b.length - a.length)
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

type ConceptLike = Pick<Concept, "sourceTerm" | "match"> & { caseSensitive?: boolean }

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
