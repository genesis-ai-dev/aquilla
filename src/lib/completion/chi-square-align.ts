/**
 * chi-square-align.ts — χ² (chi-square) word-association alignment.
 *
 * Pure, deterministic, client-side. No network, no side effects, no mutation of
 * inputs. A cheap cross-check that complements (never replaces) the IBM Model 1
 * EM aligner in interlinear.ts: for a given source token it ranks every target
 * token by the χ² statistic of their 2×2 co-occurrence contingency table across
 * the bilingual corpus.
 *
 * ## Why χ²
 *
 * EM (interlinear.ts) needs ~50 pairs to warm up; χ² gives a usable equivalent
 * candidate from the first co-occurrence and corroborates/contests EM once it is
 * warm (agreement → confidence boost, see terminology/equivalents.ts).
 *
 * ## The 2×2 contingency table (per source token s, target token t)
 *
 * Counting over the N sentence pairs (presence/absence per pair, not raw
 * frequency — a token present 3× in a pair still counts as one "present" pair):
 *
 * ```
 *               t present   t absent
 *   s present      a           b
 *   s absent       c           d
 * ```
 *
 * χ² with N = a+b+c+d:
 *
 *   χ² = N · (a·d − b·c)²  /  ((a+b)(c+d)(a+c)(b+d))
 *
 * Higher χ² ⇒ stronger (non-independent) association. We additionally require
 * the association to be *positive* (observed a exceeds expected a) so that
 * anti-correlated tokens — which also produce a large χ² — are not surfaced as
 * equivalents. Negatively-associated pairs are dropped.
 */

// ── Public types ──────────────────────────────────────────────────────────────

/** A single bilingual sentence pair. */
export interface BilingualPair {
  source: string
  target: string
}

/** A scored target-token candidate for a source term. */
export interface ChiSquareCandidate {
  /** Target token (lowercased). */
  target: string
  /** χ² independence statistic; higher = more strongly associated. */
  chi2: number
  /** Number of pairs in which BOTH the source term and this target token occur. */
  cooccurrence: number
}

export interface ChiSquareOpts {
  /** Max candidates to return (default 10). */
  maxResults?: number
}

// ── Tokenization (mirrors interlinear.ts) ─────────────────────────────────────

const TOKEN_RE = /[\p{L}\p{N}]+/gu

function tokenizeSet(s: string): Set<string> {
  return new Set(Array.from(s.matchAll(TOKEN_RE), (m) => m[0].toLowerCase()))
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Rank target tokens by χ² association with `sourceTerm` across `pairs`.
 *
 * Presence/absence is computed per pair (set membership), so co-occurrence
 * counts how many *pairs* contain both tokens, not how many times.
 *
 * Only positively-associated candidates (observed co-occurrence ≥ expected) are
 * returned — a strong negative association is not an equivalent.
 *
 * @param pairs       Bilingual (source, target) sentence pairs.
 * @param sourceTerm  Source token/term to find equivalents for (case-insensitive).
 * @param opts        maxResults (default 10).
 * @returns           Candidates sorted by χ² descending, then cooccurrence desc,
 *                     then target ascending (stable, deterministic).
 */
export function chiSquareEquivalents(
  pairs: BilingualPair[],
  sourceTerm: string,
  opts: ChiSquareOpts = {},
): ChiSquareCandidate[] {
  const maxResults = opts.maxResults ?? 10
  const term = sourceTerm.trim().toLowerCase()
  if (!term || pairs.length === 0) return []

  // Precompute per-pair target token sets and whether the source term is present.
  const N = pairs.length
  const srcPresent: boolean[] = new Array(N)
  const tgtSets: Set<string>[] = new Array(N)
  let srcPresentCount = 0 // = a + b (pairs where s present)

  // tgtPairCount: for each target token, # pairs containing it (= a + c)
  const tgtPairCount = new Map<string, number>()
  // jointCount: for each target token, # pairs containing BOTH s and t (= a)
  const jointCount = new Map<string, number>()

  for (let i = 0; i < N; i++) {
    const srcSet = tokenizeSet(pairs[i].source)
    const tgtSet = tokenizeSet(pairs[i].target)
    tgtSets[i] = tgtSet
    const hasSrc = srcSet.has(term)
    srcPresent[i] = hasSrc
    if (hasSrc) srcPresentCount++

    for (const t of tgtSet) {
      tgtPairCount.set(t, (tgtPairCount.get(t) ?? 0) + 1)
      if (hasSrc) jointCount.set(t, (jointCount.get(t) ?? 0) + 1)
    }
  }

  if (srcPresentCount === 0) return []

  const results: ChiSquareCandidate[] = []

  for (const [t, tCount] of tgtPairCount) {
    const a = jointCount.get(t) ?? 0
    if (a === 0) continue // never co-occur → no positive association

    // 2×2 table
    const b = srcPresentCount - a // s present, t absent
    const c = tCount - a // s absent, t present
    const d = N - a - b - c // s absent, t absent

    const rowS = a + b // s present
    const rowNotS = c + d // s absent
    const colT = a + c // t present
    const colNotT = b + d // t absent

    // Degenerate margins → no information, χ² undefined → skip.
    if (rowS === 0 || rowNotS === 0 || colT === 0 || colNotT === 0) continue

    // Require POSITIVE association: observed a >= expected a.
    const expectedA = (rowS * colT) / N
    if (a < expectedA) continue

    const numer = N * Math.pow(a * d - b * c, 2)
    const denom = rowS * rowNotS * colT * colNotT
    const chi2 = denom === 0 ? 0 : numer / denom

    results.push({ target: t, chi2, cooccurrence: a })
  }

  results.sort(
    (x, y) =>
      y.chi2 - x.chi2 ||
      y.cooccurrence - x.cooccurrence ||
      (x.target < y.target ? -1 : x.target > y.target ? 1 : 0),
  )

  return results.slice(0, maxResults)
}
