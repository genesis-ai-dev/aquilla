/**
 * Candidate prefilter for the terminology matcher (AQU-2654).
 *
 * A concept's regex is expensive to compile: mark folding turns every letter
 * into a class of its precomposed forms and the affix inventory adds bounded
 * alternations, so V8 spends milliseconds on each one the first time it runs.
 * A glossary has hundreds of concepts and a file mentions a handful, so the
 * matcher asks a cheap question first — CAN this concept match this text? —
 * and only compiles and runs the regex for the ones that can. The regex stays
 * the verdict. The prefilter may say "maybe" for a concept that does not
 * match; it must never say "no" for one that does.
 *
 * The argument that it never does
 * -------------------------------
 * `fold` below is a function F on strings with two properties:
 *
 *  1. It is a homomorphism: F(xy) = F(x)F(y). NFD decomposes one code point at
 *     a time and only reorders combining marks; every mark is then deleted, so
 *     what is left of `xy` is what is left of `x` followed by what is left of
 *     `y`. Case folding is applied per code point. (No NFC step: composition
 *     is not a homomorphism — Hangul jamo compose across a boundary.)
 *  2. Whatever one regex atom of a term can match folds to what the atom's own
 *     letter folds to:
 *       - a literal `c` under the `iu` flags matches `d` when the two have the
 *         same simple case folding → F(c) = F(d);
 *       - with mark folding, the atom is a class of the letter and its
 *         precomposed forms, each of which decomposes to that letter plus
 *         marks → all fold to F(letter);
 *       - the `\p{M}*` after each folded atom matches marks, which F deletes —
 *         and, under `iu`, the three iota letters that case-fold with the
 *         combining ypogegrammeni U+0345 (ι Ι ι), which F therefore deletes
 *         too, on both sides.
 *     `prefilter.test.ts` checks this for every cased code point against the
 *     regex engine itself, not against a table.
 *
 * `termToRegexSource` (./match) builds a term's pattern as its literal
 * segments (the term split on `*`) in order, with wildcards between them and
 * optional affix groups, boundaries and an exclusion lookahead around them.
 * Everything but the literal segments is optional or zero-width, so a match
 * contains, for each segment, a substring m with F(m) = F(segment) — with or
 * without mark folding, because F(stripMarks(s)) = F(s). By (1), F(segment) is
 * then a substring of F(text). The ANCHOR of a term is the longest run of
 * letters and digits in any F(segment): if the anchor is not in F(text), the
 * term cannot match. A concept is a candidate when any of its alternates
 * (sourceTerm and `match.forms`) has its anchor in the text.
 *
 * A term with no letter or digit outside its wildcards (`*`, `-`, an all-iota
 * word) has no anchor and is ALWAYS a candidate.
 *
 * Worker-safe: no `@/` aliases, no DOM. `match.ts` imports this, and the
 * workers import `match.ts`.
 */

/** Combining marks, plus the iota letters `\p{M}` also matches under `iu`. */
const DROPPED = /[\p{M}Ιιι]+/gu
// eslint-disable-next-line no-control-regex
const ASCII_ONLY = /^[\x00-\x7f]*$/
const LETTER_RUNS = /[\p{L}\p{N}]+/gu

const foldedCodePoints = new Map<string, string>()

/**
 * Case-fold one code point so that two code points the regex engine treats as
 * equal under `iu` come out equal. `toLowerCase()` alone is not that: it
 * leaves ς, ſ and ϐ apart from σ, s and β. Lower → upper → lower brings every
 * such family together, including the ones whose uppercase is two letters
 * (ß and ẞ both become "ss", the ligatures ﬅ and ﬆ both "st"). That folds
 * more than the regex does — ß is not "ss" to it — which is the safe side: the
 * only requirement is that what the regex equates, this equates.
 * `prefilter.test.ts` checks it against the engine for every cased code point.
 */
function foldCodePoint(ch: string): string {
  let folded = foldedCodePoints.get(ch)
  if (folded === undefined) {
    folded = ch.toLowerCase().toUpperCase().toLowerCase()
    foldedCodePoints.set(ch, folded)
  }
  return folded
}

function foldUncached(text: string): string {
  const stripped = text.normalize("NFD").replace(DROPPED, "")
  if (ASCII_ONLY.test(stripped)) return stripped.toLowerCase()
  let out = ""
  for (const ch of stripped) out += foldCodePoint(ch)
  // A code point can fold to a string with a mark in it (İ → i + dot above).
  return out.replace(DROPPED, "")
}

const MAX_FOLDED_TEXTS = 4096
const foldedTexts = new Map<string, string>()

/**
 * F: the text as the prefilter compares it. Memoized, because every concept
 * tested against one text asks for the same fold.
 */
export function foldForPrefilter(text: string): string {
  let folded = foldedTexts.get(text)
  if (folded === undefined) {
    folded = foldUncached(text)
    if (foldedTexts.size >= MAX_FOLDED_TEXTS) foldedTexts.clear()
    foldedTexts.set(text, folded)
  }
  return folded
}

/**
 * The anchor of one term: the longest run of letters and digits in any of its
 * folded literal segments. "" when the term has none — such a term cannot be
 * prefiltered. The term is trimmed and split exactly as `termToRegexSource`
 * does it.
 */
export function termAnchor(term: string): string {
  let best = ""
  for (const segment of term.trim().split("*")) {
    const runs = foldUncached(segment).match(LETTER_RUNS)
    if (!runs) continue
    for (const run of runs) if (run.length > best.length) best = run
  }
  return best
}

/** What must be in a folded text for a pattern to be able to match it. */
export interface Prefilter {
  /** No safe anchor: the pattern is tested against every text. */
  readonly always: boolean
  /** The pattern can match only a text containing at least one of these. */
  readonly anchors: readonly string[]
}

export const ALWAYS_CANDIDATE: Prefilter = { always: true, anchors: [] }

/**
 * The prefilter of a pattern that is an alternation of terms. Pass only the
 * alternates that compile (a blank term contributes no alternate); none at all
 * is a pattern that matches nothing.
 */
export function prefilterForTerms(terms: readonly string[]): Prefilter {
  const anchors = new Set<string>()
  for (const term of terms) {
    const anchor = termAnchor(term)
    if (anchor === "") return ALWAYS_CANDIDATE
    anchors.add(anchor)
  }
  return { always: false, anchors: [...anchors] }
}

/**
 * `on` in the app. `off` answers "maybe" to everything, which is the matcher
 * without a prefilter — the reference the parity tests compare against.
 * `verify` behaves as `on` and additionally runs the regex for every pattern
 * the prefilter turned away, throwing if it matches: the whole vitest suite
 * runs in this mode (src/test-setup.ts), so every matcher test in the repo is
 * also a parity test.
 */
export type PrefilterMode = "on" | "off" | "verify"

let mode: PrefilterMode = "on"

export function setPrefilterMode(next: PrefilterMode): void {
  mode = next
}

export function prefilterMode(): PrefilterMode {
  return mode
}

/** Can a pattern with this prefilter match `text`? "Maybe" or a certain "no". */
export function mayMatch(prefilter: Prefilter, text: string): boolean {
  if (prefilter.always || mode === "off") return true
  const folded = foldForPrefilter(text)
  for (const anchor of prefilter.anchors) if (folded.includes(anchor)) return true
  return false
}

/**
 * `verify` mode: the prefilter said `pattern` cannot match `text`. Prove it.
 * `test()` is given its own regex so no shared `lastIndex` is disturbed.
 */
export function verifyRejected(pattern: string, flags: string, text: string): void {
  if (mode !== "verify") return
  const key = `${flags}\u0001${pattern}`
  let re = verifiers.get(key)
  if (!re) {
    re = new RegExp(pattern, flags.replace("g", ""))
    verifiers.set(key, re)
  }
  if (re.test(text)) {
    throw new Error(
      `terminology prefilter rejected a pattern that matches (AQU-2654): /${pattern}/${flags} on ${JSON.stringify(text)}`,
    )
  }
}

const verifiers = new Map<string, RegExp>()

const MAX_INDEXED_TEXTS = 4096

/**
 * Many prefilters, answered together: which of them may match a text, in one
 * pass over the text instead of one test per prefilter. Entries are numbered
 * by the caller (an index into its own list), and `candidates` returns those
 * numbers in ascending order, so the caller's order is preserved.
 *
 * Anchors are filed under their first two UTF-16 units, then by length, then
 * by the anchor itself. At each position of the folded text the two units
 * found there select a bucket — for most positions there is none, and that is
 * the whole cost — and each length in the bucket is one substring lookup. An
 * anchor is found wherever it occurs, which is what `mayMatch` computes one
 * `includes` at a time; the cost follows the text and the anchors that share
 * its letter pairs, not the size of the glossary, and a thousand anchors with
 * a common prefix are still one lookup per distinct length. Building it is a
 * few map writes per anchor (a trie was measured at ~90 ms for the benchmark
 * glossary's three indexes; this is a few).
 */
export class AnchorIndex {
  private readonly always: number[] = []
  /** One-unit anchors, by that unit. */
  private readonly single = new Map<string, number[]>()
  /** Longer anchors: first two units → length → anchor → entries. */
  private readonly buckets = new Map<string, Map<number, Map<string, number[]>>>()
  private readonly entries: number[] = []
  private readonly byText = new Map<string, readonly number[]>()
  private sorted: number[] | null = null

  add(entry: number, prefilter: Prefilter): void {
    this.entries.push(entry)
    this.sorted = null
    if (this.byText.size > 0) this.byText.clear()
    if (prefilter.always) {
      this.always.push(entry)
      return
    }
    for (const anchor of prefilter.anchors) {
      let byAnchor: Map<string, number[]>
      if (anchor.length === 1) {
        byAnchor = this.single
      } else {
        const key = anchor.slice(0, 2)
        let byLength = this.buckets.get(key)
        if (!byLength) {
          byLength = new Map()
          this.buckets.set(key, byLength)
        }
        let found = byLength.get(anchor.length)
        if (!found) {
          found = new Map()
          byLength.set(anchor.length, found)
        }
        byAnchor = found
      }
      const list = byAnchor.get(anchor)
      if (list) list.push(entry)
      else byAnchor.set(anchor, [entry])
    }
  }

  /** Entries that may match `text`, ascending. Shared: do not mutate. */
  candidates(text: string): readonly number[] {
    if (mode === "off") return this.allEntries()
    let found = this.byText.get(text)
    if (found === undefined) {
      found = this.scan(foldForPrefilter(text))
      if (this.byText.size >= MAX_INDEXED_TEXTS) this.byText.clear()
      this.byText.set(text, found)
    }
    return found
  }

  private allEntries(): readonly number[] {
    if (!this.sorted) this.sorted = [...new Set(this.entries)].sort((a, b) => a - b)
    return this.sorted
  }

  private scan(folded: string): readonly number[] {
    const hits = new Set<number>(this.always)
    const singles = this.single.size > 0
    const longer = this.buckets.size > 0
    if (singles || longer) {
      for (let at = 0; at < folded.length; at += 1) {
        if (singles) {
          const list = this.single.get(folded[at])
          if (list) for (const entry of list) hits.add(entry)
        }
        if (!longer || at + 2 > folded.length) continue
        const byLength = this.buckets.get(folded.slice(at, at + 2))
        if (!byLength) continue
        for (const [length, byAnchor] of byLength) {
          if (at + length > folded.length) continue
          const list = byAnchor.get(length === 2 ? folded.slice(at, at + 2) : folded.slice(at, at + length))
          if (list) for (const entry of list) hits.add(entry)
        }
      }
    }
    return hits.size === 0 ? NO_ENTRIES : [...hits].sort((a, b) => a - b)
  }
}

const NO_ENTRIES: readonly number[] = []
