/**
 * Deterministic statistical Markov sliding-window n-gram glosser.
 *
 * Builds a word/n-gram alignment model from (source ↔ target) translated pairs
 * and produces a LITERAL back-translation of a target string into the source
 * language. No network calls. Degrades gracefully on tiny corpora.
 *
 * Public API (other agents depend on this shape — do NOT rename).
 */

// ── Public types ─────────────────────────────────────────────────────────────

export interface BtSeed {
  source: string
  target: string
  /**
   * Positive weight boosts this alignment (corrected BTs, preferred renderings).
   * Negative weight penalizes (forbidden renderings).
   */
  weight: number
}

export interface Glosser {
  gloss(target: string): string
}

// ── Internal types ────────────────────────────────────────────────────────────

interface Alignment {
  /**
   * Association strength for this (target → source) mapping — the value the
   * decoder ranks on. This is a Dice coefficient over corpus co-occurrence
   * (bounded 0..1) plus any unnormalized seed weight, NOT a raw co-occurrence
   * count. See `scoreAlignments`.
   */
  score: number
  /** Number of co-occurrence observations. */
  count: number
}

type AlignmentMap = Map<string, Map<string, Alignment>>

/** Raw weighted co-occurrence mass, before normalization. */
type CooccurrenceMap = Map<string, Map<string, Alignment>>

// ── Tokenization ─────────────────────────────────────────────────────────────

const TOKEN_RE = /[\p{L}\p{N}]+/gu

/** Split a string into lowercase tokens, preserving leading whitespace info. */
function tokenize(s: string): string[] {
  return Array.from(s.matchAll(TOKEN_RE), (m) => m[0].toLowerCase())
}

// ── Model building ────────────────────────────────────────────────────────────

const MAX_NGRAM = 3
const SEED_MULTIPLIER = 5 // how many times heavier a seed observation counts

/**
 * Add a single (target-phrase → source-phrase) alignment observation into the
 * accumulator map. `weight` is the co-occurrence weight for this update.
 */
function addAlignment(
  map: CooccurrenceMap,
  targetPhrase: string,
  sourcePhrase: string,
  weight: number,
): void {
  let inner = map.get(targetPhrase)
  if (!inner) {
    inner = new Map()
    map.set(targetPhrase, inner)
  }
  const prev = inner.get(sourcePhrase) ?? { score: 0, count: 0 }
  inner.set(sourcePhrase, { score: prev.score + weight, count: prev.count + 1 })
}

/** Where a phrase sits in its sentence, as a 0..1 fraction of sentence length. */
interface PhraseOccurrences {
  len: number
  /** Relative center of each occurrence of this phrase in the sentence. */
  centers: number[]
}

/**
 * Collect the DISTINCT n-grams of a token array with their relative positions.
 *
 * Distinctness matters: a source sentence like "in the beginning God created
 * the heavens and the earth" contains "the" three times. Counting each
 * occurrence separately tripled that phrase's co-occurrence with *every* target
 * n-gram in the pair, which is one half of why function words used to win the
 * argmax for content words (AQU-203). One sentence is one observation.
 */
function phraseOccurrences(tokens: string[], maxN: number): Map<string, PhraseOccurrences> {
  const out = new Map<string, PhraseOccurrences>()
  for (let n = 1; n <= maxN; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const phrase = tokens.slice(i, i + n).join(" ")
      const center = (i + n / 2) / tokens.length
      const prev = out.get(phrase)
      if (prev) prev.centers.push(center)
      else out.set(phrase, { len: n, centers: [center] })
    }
  }
  return out
}

/**
 * How sharply a positional mismatch discounts a co-occurrence observation.
 * A soft prior, not a constraint — an alignment attested across many pairs
 * still outscores a positionally-convenient one seen once.
 */
const DISTORTION = 2

/**
 * Positional plausibility of aligning two phrases, from their best-matching
 * occurrences: 1 when they sit at the same relative position, decaying as they
 * drift apart.
 *
 * Without this, every n-gram of a pair aligns equally well with every n-gram of
 * its translation, so on a thin corpus the decoder had nothing to choose on and
 * fell back to insertion order — glossing a mid-sentence phrase as whatever the
 * corpus happened to insert first ("in the beginning", repeatedly).
 */
function proximity(srcCenters: number[], tgtCenters: number[]): number {
  let best = 0
  for (const s of srcCenters) {
    for (const t of tgtCenters) {
      const p = 1 / (1 + DISTORTION * Math.abs(s - t))
      if (p > best) best = p
    }
  }
  return best
}

/**
 * Build the alignment model from a parallel corpus.
 * Returns a `Map<targetPhrase, Map<sourcePhrase, Alignment>>`.
 *
 * Strategy: for each (source, target) sentence pair, we emit unigram and
 * bigram alignments between every source token and every target token in the
 * same sentence window. Longer n-gram matches are scored higher.
 */
function buildAlignmentModel(
  pairs: { source: string; target: string }[],
  seeds: BtSeed[],
): AlignmentMap {
  const cooc: CooccurrenceMap = new Map()
  /** Total corpus co-occurrence mass per source phrase — the Dice denominator. */
  const srcMass = new Map<string, number>()

  // ── Corpus-derived alignments ─────────────────────────────────────────────
  for (const { source, target } of pairs) {
    const srcTokens = tokenize(source)
    const tgtTokens = tokenize(target)

    if (srcTokens.length === 0 || tgtTokens.length === 0) continue

    // Precompute each source n-gram's phrase + length ONCE per pair. Previously
    // `srcNg.join(" ")` ran inside the target loop, recomputing the same ~3·S
    // strings 3·T times each (9·S·T redundant joins per pair) — a major source
    // of transient garbage during batch completion's rebuild storm.
    const srcPhrases = phraseOccurrences(srcTokens, MAX_NGRAM)
    const tgtPhrases = phraseOccurrences(tgtTokens, MAX_NGRAM)

    // For each (source ngram, target ngram) co-occurrence, emit ONE alignment
    // observation per pair, weighted by the shorter ngram length (longer = more
    // specific = higher weight per token) and discounted by how far apart the
    // two phrases sit in their sentences.
    for (const [tgtPhrase, tp] of tgtPhrases) {
      for (const [srcPhrase, sp] of srcPhrases) {
        // Weight is geometric: single-word ×1, bigram ×2, trigram ×3
        const w = Math.min(tp.len, sp.len) * proximity(sp.centers, tp.centers)
        addAlignment(cooc, tgtPhrase, srcPhrase, w)
        srcMass.set(srcPhrase, (srcMass.get(srcPhrase) ?? 0) + w)
      }
    }
  }

  // ── Seed-derived alignments ───────────────────────────────────────────────
  // Seeds are explicit human/termbase knowledge, not statistical evidence, so
  // they are kept OUT of the co-occurrence counts and added to the normalized
  // score as an unnormalized bonus below. Folding them into `cooc` would let
  // the Dice normalization cancel them out (a seed's only mass is its own
  // observation, so it would always normalize to the same value).
  const seedScores = new Map<string, Map<string, number>>()
  for (const seed of seeds) {
    if (seed.weight === 0) continue
    const srcPhrase = tokenize(seed.source).join(" ")
    const tgtPhrase = tokenize(seed.target).join(" ")
    if (!srcPhrase || !tgtPhrase) continue
    // Seeds count as SEED_MULTIPLIER corpus observations for positive weights;
    // negative seeds directly subtract score.
    const w = seed.weight * SEED_MULTIPLIER
    let inner = seedScores.get(tgtPhrase)
    if (!inner) {
      inner = new Map()
      seedScores.set(tgtPhrase, inner)
    }
    inner.set(srcPhrase, (inner.get(srcPhrase) ?? 0) + w)
  }

  return scoreAlignments(cooc, srcMass, seedScores)
}

/**
 * Normalize raw co-occurrence into association strength, fold in seeds, and
 * collapse each target phrase to its argmax.
 *
 * **Why normalize (AQU-203).** Ranking on raw co-occurrence makes the winner
 * for any target phrase the source phrase that is simply most *frequent* in the
 * corpus. Function words ("the", "and") co-occur with everything, so they beat
 * the content word that actually aligns — the reported symptom was a Spanish
 * cell back-translating as "the God created the, the, the". Scoring by the Dice
 * coefficient
 *
 *     dice(t, s) = 2·cooc(t, s) / (mass(s) + mass(t))
 *
 * divides that frequency out: a phrase that co-occurs with everything carries a
 * large `mass(s)` and is penalized, while a phrase that co-occurs *specifically*
 * with this target wins. Bounded 0..1, so a seed bonus (± SEED_MULTIPLIER × the
 * caller's weight) still dominates by design.
 *
 * The collapse to argmax is unchanged: `glossTokens` only ever reads the single
 * highest-scoring source phrase, so retaining the full source×target n-gram
 * cross-product (~45× more entries) is pure waste — the dominant contributor to
 * the glosser's memory footprint. Tie-break mirrors the decoder's (strict `>`,
 * first-inserted wins).
 */
function scoreAlignments(
  cooc: CooccurrenceMap,
  srcMass: Map<string, number>,
  seedScores: Map<string, Map<string, number>>,
): AlignmentMap {
  const model: AlignmentMap = new Map()

  // Target phrases seen in the corpus, in seeds, or both.
  const targetPhrases = new Set<string>([...cooc.keys(), ...seedScores.keys()])

  for (const tgtPhrase of targetPhrases) {
    const inner = cooc.get(tgtPhrase)
    const seedsForTarget = seedScores.get(tgtPhrase)

    // Total corpus mass for this target phrase — the other Dice denominator.
    let tgtMass = 0
    if (inner) for (const alignment of inner.values()) tgtMass += alignment.score

    let bestSrc = ""
    let bestScore = -Infinity
    let bestCount = 0

    if (inner) {
      for (const [src, alignment] of inner) {
        const denom = (srcMass.get(src) ?? 0) + tgtMass
        const dice = denom > 0 ? (2 * alignment.score) / denom : 0
        const score = dice + (seedsForTarget?.get(src) ?? 0)
        if (score > bestScore) {
          bestScore = score
          bestSrc = src
          bestCount = alignment.count
        }
      }
    }

    // Seed-only candidates (no corpus co-occurrence) compete on seed weight.
    if (seedsForTarget) {
      for (const [src, seedScore] of seedsForTarget) {
        if (inner?.has(src)) continue
        if (seedScore > bestScore) {
          bestScore = seedScore
          bestSrc = src
          bestCount = 1
        }
      }
    }

    if (bestSrc) {
      model.set(tgtPhrase, new Map([[bestSrc, { score: bestScore, count: bestCount }]]))
    }
  }

  return model
}

// ── Gloss generation ──────────────────────────────────────────────────────────

/**
 * Maximum output token count relative to input.
 * A back-translation should be roughly as long as the source, never 2× longer.
 */
const OUTPUT_LENGTH_FACTOR = 2
const OUTPUT_LENGTH_ABS_CAP = 10 // extra headroom for short inputs

/**
 * How many consecutive times the same emitted phrase may appear before the
 * repetition guard fires and falls back to the literal token.
 */
const MAX_CONSECUTIVE_REPEATS = 2

/**
 * For each target token, find the best-scoring source phrase.
 * Uses greedy left-to-right decoding: try the longest matching n-gram first,
 * fall back to shorter n-grams, fall back to the literal token.
 *
 * Guards against runaway output:
 *  - Length cap: stops when output tokens exceed ~2× the input token count.
 *  - Repetition break: if the same emitted phrase appears more than
 *    MAX_CONSECUTIVE_REPEATS times in a row, falls back to the literal token.
 */
function glossTokens(tokens: string[], model: AlignmentMap, maxN: number): string[] {
  const output: string[] = []
  // Length cap: 2× input tokens + small absolute buffer
  const maxOutputTokens = tokens.length * OUTPUT_LENGTH_FACTOR + OUTPUT_LENGTH_ABS_CAP

  // Repetition tracking: last emitted (or currently-suppressed) phrase and its
  // consecutive run count.
  let lastEmittedPhrase = ""
  let consecutiveCount = 0

  let i = 0

  while (i < tokens.length) {
    // ── Length cap guard ─────────────────────────────────────────────────────
    if (output.length >= maxOutputTokens) break

    let matched = false
    // Set when this token's n-gram match hit the repetition guard, so the
    // literal-fallback branch below leaves the cooldown counters alone instead
    // of resetting them against the literal it's about to emit.
    let suppressed = false

    // Try longest n-gram down to unigram
    for (let n = Math.min(maxN, tokens.length - i); n >= 1; n--) {
      const phrase = tokens.slice(i, i + n).join(" ")
      const candidates = model.get(phrase)
      if (!candidates || candidates.size === 0) continue

      // Pick the candidate with the highest score (filter negatives)
      let bestSrc = ""
      let bestScore = -Infinity
      for (const [src, alignment] of candidates) {
        if (alignment.score > bestScore) {
          bestScore = alignment.score
          bestSrc = src
        }
      }

      if (bestScore > 0 && bestSrc) {
        // ── Repetition break guard ─────────────────────────────────────────
        // Track consecutive runs of the same emitted phrase.
        if (bestSrc === lastEmittedPhrase) {
          consecutiveCount++
        } else {
          consecutiveCount = 1
          lastEmittedPhrase = bestSrc
        }

        if (consecutiveCount > MAX_CONSECUTIVE_REPEATS) {
          // Phrase is cycling. Fall through to the literal fallback below, but
          // keep lastEmittedPhrase/consecutiveCount pinned on this phrase (not
          // reset to the literal) — otherwise the single interrupting literal
          // reset the count and let "phrase, phrase, [literal], phrase,
          // phrase, [literal], ..." stutter forever instead of actually
          // breaking (AQU-203 follow-up).
          suppressed = true
          break
        }

        output.push(bestSrc)
        i += n
        matched = true
        break
      }
    }

    if (!matched) {
      // Literal fallback — keep the target token as-is
      const literal = tokens[i]
      if (!suppressed) {
        // Genuine no-match (not a cooldown): reset the counter against the literal.
        if (literal === lastEmittedPhrase) {
          consecutiveCount++
        } else {
          consecutiveCount = 1
          lastEmittedPhrase = literal
        }
      }
      output.push(literal)
      i++
    }
  }

  return output
}

// ── Public factory ────────────────────────────────────────────────────────────

/**
 * Build a deterministic statistical glosser from a parallel corpus and optional
 * seeds.
 *
 * @param pairs - (source ↔ target) sentence pairs from the project's
 *   translated cells. The more pairs, the better the alignment model.
 * @param seeds - Optional override seeds. Positive weight boosts; negative
 *   weight penalizes. Default [].
 * @returns A `Glosser` whose `gloss(target)` method is synchronous and fast.
 */
export function buildGlosser(
  pairs: { source: string; target: string }[],
  seeds: BtSeed[] = [],
): Glosser {
  // Build alignment model. This is O(pairs × tokens²) but typical Bible-cell
  // corpora have short sentences so it stays well under 50 ms.
  let model: AlignmentMap
  try {
    model = buildAlignmentModel(pairs, seeds)
  } catch {
    // Degrade gracefully if model construction fails (e.g. bizarre input)
    model = new Map()
  }

  return {
    gloss(target: string): string {
      if (!target || !target.trim()) return ""

      let tokens: string[]
      try {
        tokens = tokenize(target)
      } catch {
        return target
      }

      if (tokens.length === 0) return target

      // Edge case: no corpus → return literal
      if (model.size === 0) return tokens.join(" ")

      try {
        const glossed = glossTokens(tokens, model, MAX_NGRAM)
        return glossed.join(" ")
      } catch {
        // Degrade gracefully
        return tokens.join(" ")
      }
    },
  }
}
