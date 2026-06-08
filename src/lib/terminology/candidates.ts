/**
 * Candidate-term discovery — pure, deterministic, no network.
 *
 * Mines likely key terms a translator should manage from a corpus of source /
 * WIP cell strings. Implements a standard automatic-term-recognition stack:
 *
 *  - **C-value** (Frantzi & Ananiadou): ranks candidate n-grams (length 1–5)
 *    by frequency *adjusted for nestedness*. A phrase that mostly appears
 *    inside longer candidate phrases is downweighted, so genuine multi-word
 *    terms float above incidental fragments.
 *  - **NC-value**: extends C-value with context weighting. Words that recur
 *    immediately adjacent to candidate terms (context words) boost the
 *    candidates they surround. This is the default ranked output.
 *  - **G² log-likelihood keyness** (Dunning): compares a term's frequency in
 *    the project corpus against a reference-corpus frequency map to flag terms
 *    appearing unexpectedly often — specialized vocabulary worth review. When
 *    no reference is supplied, a rest-of-corpus baseline is derived per term.
 *
 * Source-language-agnostic: no lemmatizer, no Strong's, no stopword list keyed
 * to a particular language. Tokenization is Unicode-word based.
 */

import type { Concept } from "./types"

export interface CandidateTerm {
  /** The surface term (normalized, space-joined tokens). */
  term: string
  /** Number of tokens in the term (1–5). */
  ngramLength: number
  /** Raw occurrence count across the corpus. */
  frequency: number
  /** Frantzi/Ananiadou C-value (nestedness-adjusted termhood). */
  cValue: number
  /** NC-value (C-value + adjacency context weighting). The default ranking. */
  ncValue: number
  /** G² log-likelihood keyness vs the reference corpus. */
  g2: number
  /** True if the term matches an existing managed Concept's sourceTerm. */
  isManaged: boolean
}

export interface ExtractCandidatesOptions {
  /** Existing managed concepts; their sourceTerms are flagged isManaged. */
  managed?: Concept[]
  /**
   * Reference-corpus token frequency map (token -> count) for G² keyness.
   * When absent, a rest-of-corpus baseline is derived per term.
   */
  reference?: Map<string, number>
  /** Minimum raw frequency for a candidate to be considered. Default 2. */
  minTermFreq?: number
  /** Cap on returned candidates (by ncValue desc). Default 100. */
  maxResults?: number
}

const MAX_NGRAM = 5
const DEFAULT_MIN_FREQ = 2
const DEFAULT_MAX_RESULTS = 100

/** Normalize a term for comparison / matching: trim + lowercase. */
function normalizeTerm(s: string): string {
  return s.trim().toLowerCase()
}

/**
 * Tokenize a string into lowercase word tokens. Unicode-aware: keeps letters
 * and numbers (any script), drops punctuation/whitespace. Source-language
 * agnostic — no script-specific assumptions.
 */
function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu)
  return matches ? matches : []
}

interface NgramStats {
  /** token sequence (the candidate). */
  tokens: string[]
  /** f(a): total occurrences across the corpus. */
  frequency: number
  /** multiset of (left, right) context-word occurrences around this candidate. */
  contextCounts: Map<string, number>
}

/**
 * Build all candidate n-grams (length 1..MAX_NGRAM) within each sentence,
 * recording frequency and the immediate left/right neighbour tokens (context
 * words) for NC-value weighting. N-grams never cross sentence boundaries
 * (each corpus string is one "sentence" for this purpose).
 */
function buildNgrams(corpus: string[]): Map<string, NgramStats> {
  const ngrams = new Map<string, NgramStats>()

  for (const text of corpus) {
    const tokens = tokenize(text)
    for (let n = 1; n <= MAX_NGRAM; n++) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const slice = tokens.slice(i, i + n)
        const key = slice.join(" ")
        let stat = ngrams.get(key)
        if (!stat) {
          stat = { tokens: slice, frequency: 0, contextCounts: new Map() }
          ngrams.set(key, stat)
        }
        stat.frequency += 1
        // Record immediate left and right neighbours as context words.
        const left = i > 0 ? tokens[i - 1] : undefined
        const right = i + n < tokens.length ? tokens[i + n] : undefined
        if (left) stat.contextCounts.set(left, (stat.contextCounts.get(left) ?? 0) + 1)
        if (right) stat.contextCounts.set(right, (stat.contextCounts.get(right) ?? 0) + 1)
      }
    }
  }

  return ngrams
}

/**
 * For each candidate, find the candidates that strictly contain it as a
 * contiguous sub-sequence (its "supersequences"). Used for the nestedness term.
 */
function buildContainment(
  keys: string[],
  byKey: Map<string, NgramStats>,
): Map<string, string[]> {
  const supersOf = new Map<string, string[]>()
  for (const k of keys) supersOf.set(k, [])

  // Group keys by length for an O(shorter × longer-of-greater-length) check.
  const byLen = new Map<number, string[]>()
  for (const k of keys) {
    const len = byKey.get(k)!.tokens.length
    if (!byLen.has(len)) byLen.set(len, [])
    byLen.get(len)!.push(k)
  }

  for (const shortKey of keys) {
    const shortTokens = byKey.get(shortKey)!.tokens
    const shortLen = shortTokens.length
    for (let longLen = shortLen + 1; longLen <= MAX_NGRAM; longLen++) {
      const longers = byLen.get(longLen)
      if (!longers) continue
      for (const longKey of longers) {
        if (containsSubsequence(byKey.get(longKey)!.tokens, shortTokens)) {
          supersOf.get(shortKey)!.push(longKey)
        }
      }
    }
  }
  return supersOf
}

/** True if `needle` appears as a contiguous run inside `haystack`. */
function containsSubsequence(haystack: string[], needle: string[]): boolean {
  if (needle.length > haystack.length) return false
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let match = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false
        break
      }
    }
    if (match) return true
  }
  return false
}

/**
 * C-value (Frantzi & Ananiadou).
 *
 *   C-value(a) = log2|a| · f(a)                          if a is not nested
 *   C-value(a) = log2|a| · ( f(a) − (1/|Ta|) · Σ f(b) )  otherwise
 *
 * where |a| is the n-gram length, f(a) the frequency of a, Ta the set of
 * candidate terms that contain a, and the sum runs over those longer terms.
 * Single-word terms use |a|=1 → log2(1)=0, so we add 1 to the length weight to
 * keep unigrams rankable (a common practical variant).
 */
function computeCValue(
  key: string,
  byKey: Map<string, NgramStats>,
  supersOf: Map<string, string[]>,
): number {
  const stat = byKey.get(key)!
  const lenWeight = Math.log2(stat.tokens.length + 1)
  const supers = supersOf.get(key) ?? []
  if (supers.length === 0) {
    return lenWeight * stat.frequency
  }
  let sumSuper = 0
  for (const s of supers) sumSuper += byKey.get(s)!.frequency
  const nested = stat.frequency - sumSuper / supers.length
  return lenWeight * nested
}

/**
 * NC-value (Frantzi & Ananiadou).
 *
 *   NC-value(a) = 0.8 · C-value(a) + 0.2 · Σ_b f_a(b) · weight(b)
 *
 * where b ranges over the context words of a, f_a(b) is how often b appears as
 * a context word of a, and weight(b) = t(b)/n — the share of candidate terms b
 * appears as a context word of, over the number of terms considered. Context
 * words that recur across many terms carry more termhood signal.
 */
function computeNcValue(
  key: string,
  cValue: number,
  byKey: Map<string, NgramStats>,
  contextWeight: Map<string, number>,
): number {
  const stat = byKey.get(key)!
  let contextFactor = 0
  for (const [word, count] of stat.contextCounts) {
    const w = contextWeight.get(word) ?? 0
    contextFactor += count * w
  }
  return 0.8 * cValue + 0.2 * contextFactor
}

/**
 * G² log-likelihood keyness (Dunning 1993) for a term, comparing observed
 * frequency in the project corpus against an expectation drawn from a reference
 * corpus. Higher G² ⇒ the term is more over-represented in the project (a
 * specialized term worth review). Returns 0 when the term is not
 * over-represented (under-represented terms are not "key" for our purposes).
 *
 *   a = freq in project,  b = freq in reference
 *   c = project total,    d = reference total
 *   E1 = c·(a+b)/(c+d),   E2 = d·(a+b)/(c+d)
 *   G² = 2·( a·ln(a/E1) + b·ln(b/E2) )
 */
function computeG2(
  a: number,
  b: number,
  projectTotal: number,
  referenceTotal: number,
): number {
  const c = projectTotal
  const d = referenceTotal
  if (c <= 0 || d <= 0) return 0
  const total = c + d
  const e1 = (c * (a + b)) / total
  const e2 = (d * (a + b)) / total
  let g2 = 0
  if (a > 0 && e1 > 0) g2 += a * Math.log(a / e1)
  if (b > 0 && e2 > 0) g2 += b * Math.log(b / e2)
  g2 *= 2
  // Only treat over-representation (observed rate > expected) as keyness.
  const projectRate = a / c
  const referenceRate = b / d
  if (projectRate <= referenceRate) return 0
  return g2 < 0 ? 0 : g2
}

/**
 * Extract ranked candidate terms from a corpus of cell strings.
 *
 * Deterministic and side-effect-free. The default ordering is by NC-value
 * descending (ties broken by C-value, then frequency, then alphabetically).
 */
export function extractCandidates(
  corpus: string[],
  opts: ExtractCandidatesOptions = {},
): CandidateTerm[] {
  const minTermFreq = opts.minTermFreq ?? DEFAULT_MIN_FREQ
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS

  const managedSet = new Set<string>(
    (opts.managed ?? []).map((c) => normalizeTerm(c.sourceTerm)),
  )

  const ngrams = buildNgrams(corpus)

  // Candidate pool: meet the frequency floor.
  const keys = [...ngrams.keys()].filter(
    (k) => ngrams.get(k)!.frequency >= minTermFreq,
  )
  if (keys.length === 0) return []

  const supersOf = buildContainment(keys, ngrams)

  // C-value pass.
  const cValues = new Map<string, number>()
  for (const k of keys) cValues.set(k, computeCValue(k, ngrams, supersOf))

  // Context-word weighting: how many distinct candidate terms each context
  // word borders (t(b)), normalized by the number of candidates (n).
  const termsPerContextWord = new Map<string, number>()
  for (const k of keys) {
    for (const word of ngrams.get(k)!.contextCounts.keys()) {
      termsPerContextWord.set(word, (termsPerContextWord.get(word) ?? 0) + 1)
    }
  }
  const n = keys.length
  const contextWeight = new Map<string, number>()
  for (const [word, t] of termsPerContextWord) contextWeight.set(word, t / n)

  // NC-value pass.
  const ncValues = new Map<string, number>()
  for (const k of keys) {
    ncValues.set(k, computeNcValue(k, cValues.get(k)!, ngrams, contextWeight))
  }

  // G² keyness. Reference: supplied map, else derive a rest-of-corpus baseline
  // from unigram frequencies (every other unigram acts as the reference mass).
  const haveReference = opts.reference !== undefined && opts.reference.size > 0
  const reference = opts.reference
  let referenceTotal = 0
  if (haveReference) {
    for (const v of reference!.values()) referenceTotal += v
  }

  // Project unigram totals over ALL unigram types (not just above-floor ones)
  // so the rest-of-corpus baseline is faithful. G² is computed token-wise; for
  // multi-word terms we use the minimum unigram keyness across the term's
  // tokens as a conservative proxy.
  const projectUnigramFreq = new Map<string, number>()
  let projectUnigramTotal = 0
  for (const [k, stat] of ngrams) {
    if (stat.tokens.length === 1) {
      projectUnigramFreq.set(k, stat.frequency)
      projectUnigramTotal += stat.frequency
    }
  }
  const distinctUnigramTypes = projectUnigramFreq.size || 1

  function tokenG2(token: string, freq: number): number {
    if (haveReference) {
      const b = reference!.get(token) ?? 0
      return computeG2(freq, b, projectUnigramTotal, referenceTotal)
    }
    // Rest-of-corpus baseline: reference = the rest of the project's unigrams.
    const restTotal = projectUnigramTotal - freq
    // Expectation that the token is "average": compare its count against the
    // mean count of the remaining unigram types. Use b = mean-of-rest as the
    // reference observation so G² flags tokens far above the corpus average.
    const meanRest = restTotal / Math.max(distinctUnigramTypes - 1, 1)
    return computeG2(freq, meanRest, projectUnigramTotal, restTotal || 1)
  }

  const g2ByKey = new Map<string, number>()
  for (const k of keys) {
    const stat = ngrams.get(k)!
    if (stat.tokens.length === 1) {
      g2ByKey.set(k, tokenG2(stat.tokens[0], stat.frequency))
    } else {
      // Conservative multi-word proxy: min token-level keyness (the term is
      // only "key" if all its tokens are at least somewhat over-represented).
      let min = Infinity
      for (const tok of stat.tokens) {
        const f = projectUnigramFreq.get(tok) ?? ngrams.get(tok)?.frequency ?? 0
        const g = tokenG2(tok, f)
        if (g < min) min = g
      }
      g2ByKey.set(k, min === Infinity ? 0 : min)
    }
  }

  const results: CandidateTerm[] = keys.map((k) => {
    const stat = ngrams.get(k)!
    return {
      term: k,
      ngramLength: stat.tokens.length,
      frequency: stat.frequency,
      cValue: round(cValues.get(k)!),
      ncValue: round(ncValues.get(k)!),
      g2: round(g2ByKey.get(k)!),
      isManaged: managedSet.has(k),
    }
  })

  results.sort((a, b) => {
    if (b.ncValue !== a.ncValue) return b.ncValue - a.ncValue
    if (b.cValue !== a.cValue) return b.cValue - a.cValue
    if (b.frequency !== a.frequency) return b.frequency - a.frequency
    return a.term.localeCompare(b.term)
  })

  return results.slice(0, maxResults)
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
