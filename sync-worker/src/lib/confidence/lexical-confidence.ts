// AD-14 health-as-confidence: lexical, one-hop scorer.
//
// Health is reframed as "does this look like a translation that ought to be
// validated?" — a confidence score derived from how closely a cell resembles
// the project's *already-validated* cells. This module is the pure scoring
// primitive; candidate retrieval (which validated cells to compare against)
// is the caller's job (Postgres full-text, see scoped-search.ts).
//
// One hop: confidence is measured against ground-truth validated cells only,
// never against other cells' (predicted) confidence — so there is no recursion
// and the score is cheap and well-defined.

import { ngramSet } from "../text/char-ngrams"

/**
 * The comparable terms of a text: its distinct character n-grams
 * (`../text/char-ngrams`), the same unit example retrieval covers a verse
 * by. Words were the unit until AQU-2727, which left Chinese, Thai and Burmese
 * with one "term" per verse and Korean with forms nobody repeats; n-grams
 * know nothing about spaces, so every script scores the same way.
 */
export function confidenceTerms(raw: string): Set<number> {
  return ngramSet(raw)
}

/**
 * One-hop lexical confidence in [0, 1]: the largest fraction of the query
 * cell's distinct terms (character n-grams) that any single validated
 * neighbor covers. Intuition —
 * "is there a validated cell that looks like most of what I say?" Returns 0
 * when the query has no terms or there are no neighbors.
 */
export function lexicalConfidence(queryText: string, neighborTexts: string[]): number {
  const queryTerms = confidenceTerms(queryText)
  if (queryTerms.size === 0) return 0

  let best = 0
  for (const neighbor of neighborTexts) {
    const neighborTerms = confidenceTerms(neighbor)
    let overlap = 0
    for (const term of queryTerms) {
      if (neighborTerms.has(term)) overlap++
    }
    const coverage = overlap / queryTerms.size
    if (coverage > best) best = coverage
    if (best === 1) break
  }
  return best
}

/**
 * Symmetric lexical similarity in [0, 1] between two texts: Jaccard over their
 * distinct terms (|A ∩ B| / |A ∪ B|), same tokenization as above.
 *
 * Symmetric on purpose, unlike `lexicalConfidence`'s one-directional coverage
 * (AQU-1232). Coverage answers "how much of A does B cover?", which a very long
 * B trivially maximizes — fine when B is a validated exemplar, wrong when the
 * caller asked "which cell is most LIKE this one" and would be handed a
 * rambling superset. Jaccard penalizes the extra terms on either side, so a
 * near-duplicate line outranks a long line that merely contains it.
 */
export function lexicalSimilarity(a: string, b: string): number {
  const aTerms = confidenceTerms(a)
  const bTerms = confidenceTerms(b)
  if (aTerms.size === 0 || bTerms.size === 0) return 0

  let intersection = 0
  for (const term of aTerms) {
    if (bTerms.has(term)) intersection++
  }
  if (intersection === 0) return 0
  const union = aTerms.size + bTerms.size - intersection
  return intersection / union
}
