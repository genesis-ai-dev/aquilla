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
 *   - leading boundary  → `(?<!\p{L})`  (not preceded by a letter)
 *   - trailing boundary → `(?!\p{L})`   (not followed by a letter)
 * A term WITHOUT a leading `*` gets a leading boundary; WITHOUT a trailing `*`
 * gets a trailing boundary. A term WITH a trailing `*` ends in `\p{L}*` and gets
 * NO trailing boundary, so the inflectional suffix is consumed greedily.
 *
 * Backward compatibility: a term with NO `*` becomes
 * `(?<!\p{L})escaped(?!\p{L})` — i.e. exact whole-word, case-insensitive,
 * Unicode-aware matching, a strict superset of the old `\b…\b` behaviour for
 * the cases the app cares about (whole-word, alphabetic terms).
 *
 * Regex-injection safety: every non-`*` character is regex-escaped, so a term
 * like `a.b` matches the literal text "a.b", never "axb".
 */

/** Escape a string for safe literal use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const LEAD_BOUNDARY = "(?<!\\p{L})"
const TRAIL_BOUNDARY = "(?!\\p{L})"
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
  const alts = [...new Set(list)]
    .sort((a, b) => b.length - a.length)
    .map((a) => literalSegment(a, fold))
    .join("|")
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
