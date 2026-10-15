/**
 * Shared find/replace matching for the search dock, the find dialog, and the
 * sync-worker pattern search.
 *
 * Default (every flag off) is a case-insensitive literal substring, which is
 * what Replace already did. Match case, whole word, and regular expression
 * are opt-in. Preserve case only changes the replacement text.
 *
 * Postgres ARE is not JavaScript regex: `\b` is a backspace there, and
 * lookaround / `\p{}` are unsupported. `postgresCanRunRegexp` tells the
 * worker when it must match in JS instead of pushing the pattern into `~`.
 */

export interface TextFindOptions {
  /** Case-sensitive. Default false. */
  matchCase?: boolean
  /** The hit must not sit inside a longer word. Default false. */
  wholeWord?: boolean
  /** Treat `query` as a JavaScript regular expression. Default false. */
  useRegexp?: boolean
}

export interface TextReplaceOptions extends TextFindOptions {
  /** Adapt each replacement to the case of the text it replaces. */
  preserveCase?: boolean
}

export interface TextMatch {
  index: number
  /** The matched slice, including the text a whole-word boundary wrapped. */
  text: string
  /** Capturing groups in `$1` order. Missing groups are "". */
  groups: string[]
}

const WORD_BOUNDARY = String.raw`(?<![\p{L}\p{M}\p{N}_])`
const WORD_END = String.raw`(?![\p{L}\p{M}\p{N}_])`

/** JS constructs Postgres `~` will not honor. `\b` is a backspace in ARE. */
const NOT_POSTGRES_REGEXP = /\(\?|\\[bBpPk]/

export function postgresCanRunRegexp(pattern: string): boolean {
  return !NOT_POSTGRES_REGEXP.test(pattern)
}

export function findPatternError(query: string, options: TextFindOptions): string | null {
  if (!options.useRegexp || query === "") return null
  try {
    compileFind(query, options)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : "invalid regular expression"
  }
}

export function findTextMatches(
  haystack: string,
  query: string,
  options: TextFindOptions = {},
): TextMatch[] {
  if (!query) return []
  let re: RegExp
  try {
    re = compileFind(query, options)
  } catch {
    return []
  }
  const out: TextMatch[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(haystack)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1
      if (re.lastIndex > haystack.length) break
      continue
    }
    out.push({
      index: m.index,
      text: m[0],
      groups: m.slice(1).map((group) => group ?? ""),
    })
  }
  return out
}

/**
 * A `<mark>` window around the first hit, for the search snippet renderer.
 * The cell text is copied through unchanged apart from the two mark tags.
 */
export function markedSnippet(value: string, match: TextMatch, radius = 40): string {
  const start = Math.max(0, match.index - radius)
  const end = Math.min(value.length, match.index + match.text.length + radius)
  return (
    (start > 0 ? "…" : "") +
    value.slice(start, match.index) +
    "<mark>" +
    match.text +
    "</mark>" +
    value.slice(match.index + match.text.length, end) +
    (end < value.length ? "…" : "")
  )
}

/**
 * Replacement text for one hit. Regexp mode expands `$&`, `$0`, `$$`, and
 * `$1`…`$99` first; preserve case then follows the case of the matched text.
 */
export function replacementForMatch(
  match: TextMatch,
  replacement: string,
  options: TextReplaceOptions = {},
): string {
  const expanded = options.useRegexp ? expandRegexpReplacement(match, replacement) : replacement
  return options.preserveCase ? preserveMatchedCase(match.text, expanded) : expanded
}

export function preserveMatchedCase(matched: string, replacement: string): string {
  if (!replacement) return replacement
  const cased = Array.from(matched).filter(isCased)
  if (cased.length === 0) return replacement
  if (cased.every(isUpper)) return replacement.toUpperCase()
  if (cased.every(isLower)) return replacement.toLowerCase()
  if (isUpper(cased[0]) && cased.slice(1).every(isLower)) return toTitleCase(replacement)
  return replacement
}

function compileFind(query: string, options: TextFindOptions): RegExp {
  const body = options.useRegexp ? query : escapeLiteral(query)
  const source = options.wholeWord ? `${WORD_BOUNDARY}(?:${body})${WORD_END}` : body
  const flags = options.matchCase ? "gu" : "giu"
  return new RegExp(source, flags)
}

function escapeLiteral(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function expandRegexpReplacement(match: TextMatch, replacement: string): string {
  return replacement.replace(/\$(\$|&|0|[1-9]\d?)/g, (_raw, token: string) => {
    if (token === "$") return "$"
    if (token === "&" || token === "0") return match.text
    return match.groups[Number(token) - 1] ?? ""
  })
}

function isCased(ch: string): boolean {
  return ch.toLowerCase() !== ch.toUpperCase()
}

function isUpper(ch: string): boolean {
  return ch === ch.toUpperCase()
}

function isLower(ch: string): boolean {
  return ch === ch.toLowerCase()
}

function toTitleCase(replacement: string): string {
  const chars = Array.from(replacement)
  const first = chars.findIndex(isCased)
  if (first < 0) return replacement
  chars[first] = chars[first].toUpperCase()
  for (let i = first + 1; i < chars.length; i++) chars[i] = chars[i].toLowerCase()
  return chars.join("")
}
