/**
 * Normalized Levenshtein edit distance.
 *
 * Returns a value in [0, 1] where:
 *   0 = identical strings
 *   1 = completely different (one is empty, or all chars differ at max-len cost)
 *
 * Uses character-level comparison. For translation quality metrics this is
 * an approximation — word-level TER (Translation Edit Rate) would be more
 * linguistically meaningful, but Levenshtein on characters is deterministic,
 * dependency-free, and good enough for trend-over-time views.
 *
 * APPROXIMATION NOTE (AQU-311): true post-edit magnitude uses word-level
 * HTER or TER. Character-level NED overestimates distance for languages with
 * rich morphology and underestimates for languages with long compound words.
 * This is a pragmatic first version; a word-level variant is left as
 * SWARM-TODO below.
 *
 * SWARM-TODO(fro-311-word-level-ter): upgrade to word-level TER for more
 * accurate MTPE quality metrics. Word tokenization needs to handle CJK,
 * Arabic, and right-to-left scripts. Consider importing `wink-distance` or
 * `natural` when a dependency is acceptable.
 */

/**
 * Raw Levenshtein distance between two strings (character-level).
 * Uses a two-row DP table — O(min(m,n)) space.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Ensure `a` is the shorter string (rows = shorter length + 1)
  if (a.length > b.length) {
    const tmp = a
    a = b
    b = tmp
  }

  const m = a.length
  const n = b.length
  let prev = new Array<number>(m + 1)
  let curr = new Array<number>(m + 1)

  for (let i = 0; i <= m; i++) prev[i] = i

  for (let j = 1; j <= n; j++) {
    curr[0] = j
    for (let i = 1; i <= m; i++) {
      if (a[i - 1] === b[j - 1]) {
        curr[i] = prev[i - 1]
      } else {
        curr[i] = 1 + Math.min(prev[i - 1], prev[i], curr[i - 1])
      }
    }
    // swap rows
    const tmp = prev
    prev = curr
    curr = tmp
  }

  return prev[m]
}

/**
 * Normalized edit distance: `levenshteinDistance(a, b) / max(len(a), len(b))`.
 *
 * Returns 0 for identical strings and 1 when one string is empty or they share
 * no common characters at minimum cost. Returns 0 when both strings are empty.
 */
export function normalizedEditDistance(a: string, b: string): number {
  if (a === b) return 0
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 0
  return levenshteinDistance(a, b) / maxLen
}
