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
 * letters. We expand it to `\p{L}*` — zero-or-more Unicode *letters*.
 *
 *   - `\p{L}` (Unicode letter) is chosen over `\w` deliberately:
 *       · `\w` is ASCII-only ([A-Za-z0-9_]) and would NOT match accented /
 *         non-Latin inflections (gracia's "í", Greek, Cyrillic, …) — the whole
 *         point of this feature is cross-script inflection.
 *       · `\w` also matches digits and `_`, which are not inflectional letters.
 *     `\p{L}` (with the `u` flag) matches a letter in any script and nothing
 *     else, which is exactly "an inflectional run".
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
/** A wildcard `*` expands to an inflectional run of zero-or-more Unicode letters. */
const WILDCARD = "\\p{L}*"

/**
 * Convert a user term into a regex source string with inflectional wildcard and
 * word-boundary semantics (see file header). Returns `null` for empty /
 * whitespace-only terms (nothing to match).
 */
export function termToRegexSource(term: string): string | null {
  const trimmed = term.trim()
  if (!trimmed) return null

  const hasLeadingStar = trimmed.startsWith("*")
  const hasTrailingStar = trimmed.endsWith("*")

  // Split on `*`, escape each literal segment, rejoin with the wildcard run.
  const body = trimmed.split("*").map(escapeRegex).join(WILDCARD)

  const lead = hasLeadingStar ? "" : LEAD_BOUNDARY
  const trail = hasTrailingStar ? "" : TRAIL_BOUNDARY
  return `${lead}${body}${trail}`
}

/**
 * Build a RegExp for a term. Returns `null` for empty/whitespace terms.
 * Default flags: case-insensitive + Unicode. Add `g` for global scanning.
 */
export function buildTermRegex(term: string, flags = "iu"): RegExp | null {
  const src = termToRegexSource(term)
  if (src === null) return null
  return new RegExp(src, flags)
}

/** True if `haystack` contains a match for `term` (case-insensitive, Unicode). */
export function matchesTerm(haystack: string, term: string): boolean {
  if (!haystack) return false
  const re = buildTermRegex(term)
  return re !== null && re.test(haystack)
}
