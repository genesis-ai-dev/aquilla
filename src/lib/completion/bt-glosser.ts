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
  /** Total weighted score for this (target → source) mapping. */
  score: number
  /** Number of co-occurrence observations. */
  count: number
}

type AlignmentMap = Map<string, Map<string, Alignment>>

// ── Tokenization ─────────────────────────────────────────────────────────────

const TOKEN_RE = /[\p{L}\p{N}]+/gu

/** Split a string into lowercase tokens, preserving leading whitespace info. */
function tokenize(s: string): string[] {
  return Array.from(s.matchAll(TOKEN_RE), (m) => m[0].toLowerCase())
}

/** Collect n-grams of lengths 1..maxN from a token array. */
function ngrams(tokens: string[], maxN: number): string[][] {
  const result: string[][] = []
  for (let n = 1; n <= maxN; n++) {
    for (let i = 0; i <= tokens.length - n; i++) {
      result.push(tokens.slice(i, i + n))
    }
  }
  return result
}

// ── Model building ────────────────────────────────────────────────────────────

const MAX_NGRAM = 3
const SEED_MULTIPLIER = 5 // how many times heavier a seed observation counts

/**
 * Add a single (target-phrase → source-phrase) alignment observation into the
 * accumulator map. `weight` is the co-occurrence weight for this update.
 */
function addAlignment(
  map: AlignmentMap,
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
  const map: AlignmentMap = new Map()

  // ── Corpus-derived alignments ─────────────────────────────────────────────
  for (const { source, target } of pairs) {
    const srcTokens = tokenize(source)
    const tgtTokens = tokenize(target)

    if (srcTokens.length === 0 || tgtTokens.length === 0) continue

    const srcNgrams = ngrams(srcTokens, MAX_NGRAM)
    const tgtNgrams = ngrams(tgtTokens, MAX_NGRAM)

    // For each (source ngram, target ngram) co-occurrence, emit an alignment
    // observation weighted by the shorter ngram length (longer = more specific
    // = higher weight per token).
    for (const tgNg of tgtNgrams) {
      const tgtPhrase = tgNg.join(" ")
      const tgtLen = tgNg.length
      for (const srcNg of srcNgrams) {
        const srcPhrase = srcNg.join(" ")
        const srcLen = srcNg.length
        // Weight is geometric: single-word ×1, bigram ×2, trigram ×3
        const w = Math.min(tgtLen, srcLen)
        addAlignment(map, tgtPhrase, srcPhrase, w)
      }
    }
  }

  // ── Seed-derived alignments ───────────────────────────────────────────────
  for (const seed of seeds) {
    if (seed.weight === 0) continue
    const srcPhrase = tokenize(seed.source).join(" ")
    const tgtPhrase = tokenize(seed.target).join(" ")
    if (!srcPhrase || !tgtPhrase) continue
    // Seeds count as SEED_MULTIPLIER corpus observations for positive weights;
    // negative seeds directly subtract score.
    const w = seed.weight > 0
      ? seed.weight * SEED_MULTIPLIER
      : seed.weight * SEED_MULTIPLIER // same formula, sign carries through
    addAlignment(map, tgtPhrase, srcPhrase, w)
  }

  return map
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

  // Repetition tracking: last emitted phrase and its consecutive run count
  let lastEmittedPhrase = ""
  let consecutiveCount = 0

  let i = 0

  while (i < tokens.length) {
    // ── Length cap guard ─────────────────────────────────────────────────────
    if (output.length >= maxOutputTokens) break

    let matched = false

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
          // Phrase is cycling — fall through to literal fallback below
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
      // Reset repetition counter since we're emitting a literal
      if (literal === lastEmittedPhrase) {
        consecutiveCount++
      } else {
        consecutiveCount = 1
        lastEmittedPhrase = literal
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
