// AD-14 health-as-confidence: lexical, one-hop scorer.
//
// Health is reframed as "does this look like a translation that ought to be
// validated?" — a confidence score derived from how closely a cell resembles
// the project's *already-validated* cells. This module is the pure scoring
// primitive; candidate retrieval (which validated cells to compare against)
// is the caller's job (FTS5, see scoped-search.ts).
//
// One hop: confidence is measured against ground-truth validated cells only,
// never against other cells' (predicted) confidence — so there is no recursion
// and the score is cheap and well-defined.

/**
 * Split text into comparable terms: lowercased maximal runs of Unicode letters
 * or digits. Drops punctuation (incl. the Devanagari danda ॥ / ।) and folds
 * case, approximating FTS5's unicode61 tokenizer closely enough for coverage
 * scoring (FTS only does candidate retrieval; the score is computed here).
 */
export function tokenizeForConfidence(raw: string): string[] {
  if (!raw) return []
  // Include \p{M} (combining marks): Indic/Brahmic scripts attach vowel signs
  // and viramas as marks, so excluding them shatters words like "अब्राहामले"
  // into fragments. Letters + marks + digits keeps whole words intact.
  return raw.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
}

/**
 * One-hop lexical confidence in [0, 1]: the largest fraction of the query
 * cell's distinct terms that any single validated neighbor covers. Intuition —
 * "is there a validated cell that looks like most of what I say?" Returns 0
 * when the query has no terms or there are no neighbors.
 */
export function lexicalConfidence(queryText: string, neighborTexts: string[]): number {
  const queryTerms = new Set(tokenizeForConfidence(queryText))
  if (queryTerms.size === 0) return 0

  let best = 0
  for (const neighbor of neighborTexts) {
    const neighborTerms = new Set(tokenizeForConfidence(neighbor))
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
