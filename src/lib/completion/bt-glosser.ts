/**
 * Deterministic statistical Markov sliding-window n-gram glosser.
 *
 * Builds a word/n-gram alignment model from (source ↔ target) translated pairs
 * and produces a LITERAL back-translation of a target string into the source
 * language. No network calls. Degrades gracefully on tiny corpora.
 *
 * Public API (other agents depend on this shape — do NOT rename).
 */

import { tokenize } from "./tokenize"

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

/**
 * AQU-207: weight given to one confirmed interlinear alignment when it is fed
 * back into the glosser as a seed.
 *
 * Calibrated against the other seed sources in the workspace so an explicit
 * per-token confirmation outranks an "admitted" rendering (1) but stays below a
 * "preferred" one (3) — a single word link is a narrower claim than a termbase
 * entry. `buildAlignmentModel` multiplies every seed by `SEED_MULTIPLIER` and
 * adds it as an unnormalized bonus on top of the corpus association, which is
 * a Dice coefficient bounded 0..1 (AQU-203, see `scoreAlignments`). The
 * effective contribution is therefore ±10 against at most 1 from the corpus:
 * a confirmed link cannot be outvoted by co-occurrence evidence alone, only by
 * a heavier seed such as a "preferred" termbase rendering. The bonus applies to
 * every target n-gram that contains the confirmed token, not just the bare
 * token (see `SeedRule`), because the decoder tries the longest n-gram first
 * and would otherwise never consult the entry the seed adjusted.
 */
export const ALIGNMENT_SEED_BT_WEIGHT = 2

/**
 * AQU-207: adapt confirmed/invalidated interlinear alignments into glosser seeds.
 *
 * `AlignmentSeed` and `BtSeed` describe the same relation with different field
 * names — `srcToken`/`tgtToken` vs `source`/`target` — and both are oriented
 * source-language → target-language, so the mapping is positional, not a swap.
 * Sign carries through: a confirmed link boosts the alignment, an invalidated
 * one penalizes it.
 *
 * This is the seam that makes a confirm in the interlinear panel actually move
 * subsequent statistical BT output; without it the seeds only ever fed
 * `interlinear.ts`'s own model and the BT ignored the user's corrections.
 */
export function btSeedsFromAlignmentSeeds(
  seeds: readonly import("./interlinear").AlignmentSeed[],
): BtSeed[] {
  const out: BtSeed[] = []
  for (const seed of seeds) {
    if (seed.weight === 0) continue
    if (!seed.srcToken?.trim() || !seed.tgtToken?.trim()) continue
    out.push({
      source: seed.srcToken,
      target: seed.tgtToken,
      weight: seed.weight * ALIGNMENT_SEED_BT_WEIGHT,
    })
  }
  return out
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

/**
 * AQU-1190: shared with `interlinear.ts` so the gloss and the alignment it is
 * read against cannot disagree about where a word ends.
 *
 * This module's own copy of the regex was `[\p{L}\p{N}]+` — no `\p{M}` — so
 * every pointed-Hebrew word was shredded into single consonants and the
 * statistical gloss for a Macula/OSHB source was built over fragments rather
 * than words. See `./tokenize` for the rule and the other scripts it affects.
 */

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
  const rules = compileSeedRules(seeds)

  return scoreAlignments(cooc, srcMass, rules)
}

/**
 * A seed as the scorer applies it: a claim that wherever the target phrase
 * `tgt` occurs, its gloss goes through the source phrase `src`.
 *
 * The claim is scored on every target n-gram that CONTAINS `tgt`, not only on
 * `tgt` itself. `glossTokens` decodes longest-n-gram-first, so a seed that
 * only adjusted the bare pair ("reine" → "king", −10) was never consulted
 * when the trigram "la reine aime" already had a corpus winner ("the king
 * loves") — the confirmation persisted, the model changed, and the BT the
 * user read did not move (AQU-207, qa-bot walk on PR #548).
 */
interface SeedRule {
  tgt: string[]
  tgtPhrase: string
  src: string[]
  srcPhrase: string
  /** Signed bonus: the caller's weight × SEED_MULTIPLIER. */
  w: number
}

interface SeedRules {
  all: SeedRule[]
  /** Rules keyed by the first token of their target phrase, for lookup. */
  byFirstToken: Map<string, SeedRule[]>
}

const NO_RULES: SeedRule[] = []

function compileSeedRules(seeds: BtSeed[]): SeedRules {
  const all: SeedRule[] = []
  const byFirstToken = new Map<string, SeedRule[]>()
  for (const seed of seeds) {
    if (seed.weight === 0) continue
    const src = tokenize(seed.source)
    const tgt = tokenize(seed.target)
    if (src.length === 0 || tgt.length === 0) continue
    // A target phrase longer than any n-gram the decoder asks for can never be
    // contained in one, so the rule could not fire; drop it at compile time.
    if (tgt.length > MAX_NGRAM) continue
    const rule: SeedRule = {
      tgt,
      tgtPhrase: tgt.join(" "),
      src,
      srcPhrase: src.join(" "),
      // Seeds count as SEED_MULTIPLIER corpus observations for positive
      // weights; negative seeds directly subtract score.
      w: seed.weight * SEED_MULTIPLIER,
    }
    all.push(rule)
    let bucket = byFirstToken.get(tgt[0])
    if (!bucket) {
      bucket = []
      byFirstToken.set(tgt[0], bucket)
    }
    bucket.push(rule)
  }
  return { all, byFirstToken }
}

/** True if `needle` occurs in `hay` as a contiguous run of whole tokens. */
function containsSeq(hay: readonly string[], needle: readonly string[]): boolean {
  const n = needle.length
  if (n === 0 || n > hay.length) return false
  outer: for (let i = 0; i + n <= hay.length; i++) {
    for (let j = 0; j < n; j++) {
      if (hay[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

/** The rules whose target phrase is contained in `tgtTokens`, each at most once. */
function rulesFor(tgtTokens: readonly string[], rules: SeedRules): SeedRule[] {
  let out: SeedRule[] | null = null
  for (let i = 0; i < tgtTokens.length; i++) {
    const bucket = rules.byFirstToken.get(tgtTokens[i])
    if (!bucket) continue
    for (const rule of bucket) {
      if (rule.tgt.length > tgtTokens.length - i) continue
      let matches = true
      for (let j = 1; j < rule.tgt.length; j++) {
        if (tgtTokens[i + j] !== rule.tgt[j]) {
          matches = false
          break
        }
      }
      if (!matches) continue
      if (out?.includes(rule)) continue
      ;(out ??= []).push(rule)
    }
  }
  return out ?? NO_RULES
}

/**
 * The seed bonus for glossing a target phrase (whose applicable rules are
 * `applicable`) through `srcTokens`.
 *
 * Each rule votes for the candidates that agree with it and against the ones
 * that do not: a candidate containing the rule's source phrase gets `+w`, any
 * other candidate gets `−w`. Voting against matters for a confirmation — a
 * bonus on the confirmed candidate alone would leave the corpus winner
 * ("the king loves") untouched, and Dice differences never exceed 1, so the
 * disagreeing candidate has to be pushed below the agreeing one explicitly.
 * For an invalidation (`w < 0`) the signs flip and the same rule reads
 * "anything but this".
 */
function seedBonus(srcTokens: readonly string[], applicable: readonly SeedRule[]): number {
  let bonus = 0
  for (const rule of applicable) {
    bonus += containsSeq(srcTokens, rule.src) ? rule.w : -rule.w
  }
  return bonus
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
 * Seeds are applied as rules over containment (see `SeedRule`): every target
 * phrase containing a seeded target phrase scores each candidate by whether it
 * contains the seeded source phrase. The bare seeded pair is additionally a
 * candidate in its own right when the corpus never paired the two, so a
 * termbase rendering the corpus has not used yet can still surface.
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
  rules: SeedRules,
): AlignmentMap {
  const model: AlignmentMap = new Map()

  // Target phrases seen in the corpus, in seeds, or both.
  const targetPhrases = new Set<string>(cooc.keys())
  for (const rule of rules.all) targetPhrases.add(rule.tgtPhrase)

  for (const tgtPhrase of targetPhrases) {
    const inner = cooc.get(tgtPhrase)
    const applicable = rules.all.length > 0 ? rulesFor(tgtPhrase.split(" "), rules) : NO_RULES

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
        const score = dice + (applicable.length > 0 ? seedBonus(src.split(" "), applicable) : 0)
        if (score > bestScore) {
          bestScore = score
          bestSrc = src
          bestCount = alignment.count
        }
      }
    }

    // Seed-only candidates (no corpus co-occurrence) compete on seed weight.
    // Only a rule whose target IS this phrase proposes its own source phrase;
    // a rule merely contained in it would propose a partial gloss.
    for (const rule of applicable) {
      if (rule.tgtPhrase !== tgtPhrase) continue
      if (inner?.has(rule.srcPhrase)) continue
      const score = seedBonus(rule.src, applicable)
      if (score > bestScore) {
        bestScore = score
        bestSrc = rule.srcPhrase
        bestCount = 1
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
 * How many consecutive times a repeating run (see MAX_CYCLE_LEN) may appear
 * before the repetition guard fires and falls back to the literal token.
 */
const MAX_CONSECUTIVE_REPEATS = 2

/**
 * Longest repeating unit the cycle guard checks for. 1 catches the same
 * phrase emitted over and over ("the the the…"); 2 and 3 catch a short
 * alternating loop ("cat dog cat dog…", "the lord said the lord said…") —
 * two or three phrases so mutually dominant they keep winning the argmax
 * back and forth even though no single phrase repeats on its own.
 */
const MAX_CYCLE_LEN = 3

/**
 * True if appending `candidate` to `history` would complete
 * MAX_CONSECUTIVE_REPEATS+1 consecutive repeats of some cycle of length
 * 1..MAX_CYCLE_LEN (e.g. history […, cat, dog, cat] + candidate dog → the
 * 2-cycle [cat, dog] repeated 3× in a row).
 */
function formsExcessiveCycle(history: readonly string[], candidate: string): boolean {
  const seq = [...history, candidate]
  for (let cycleLen = 1; cycleLen <= MAX_CYCLE_LEN; cycleLen++) {
    const needed = cycleLen * (MAX_CONSECUTIVE_REPEATS + 1)
    if (seq.length < needed) continue
    const window = seq.slice(seq.length - needed)
    const isRepeating = window.every((phrase, idx) => phrase === window[idx % cycleLen])
    if (isRepeating) return true
  }
  return false
}

/**
 * For each target token, find the best-scoring source phrase.
 * Uses greedy left-to-right decoding: try the longest matching n-gram first,
 * fall back to shorter n-grams, fall back to the literal token.
 *
 * Guards against runaway output:
 *  - Length cap: stops when output tokens exceed ~2× the input token count.
 *  - Repetition break: if the phrase the model wants to emit would extend a
 *    repeating run (single phrase or a short alternating cycle, see
 *    MAX_CYCLE_LEN) past MAX_CONSECUTIVE_REPEATS, falls back to the literal
 *    token instead.
 */
/**
 * Append a model-selected source `phrase`'s words to `output`, dropping any
 * leading words that duplicate the word(s) already at the tail of `output`.
 *
 * The decoder picks the best-scoring source phrase for each target n-gram
 * window independently, so two adjacent phrases can each legitimately border
 * the same word — e.g. one phrase's source ends "...created the" and the
 * very next phrase's source happens to start "the heaven..." — a boundary
 * artifact of phrase-based decoding, not a property of either language. Left
 * alone it reads as a stutter ("created the the heaven"); collapsing the
 * overlap removes the duplicate without changing the meaning.
 *
 * Only for model phrases: a literal fallback token is pushed plainly (see
 * below), never through here, because its repetition (if any) reflects the
 * target text's own content, not a decoder boundary artifact — deduping it
 * would silently drop genuinely repeated words.
 */
function pushDeduped(output: string[], phrase: string): void {
  const words = phrase.split(" ")
  let start = 0
  while (start < words.length && output[output.length - 1] === words[start]) start++
  for (let k = start; k < words.length; k++) output.push(words[k])
}

function glossTokens(tokens: string[], model: AlignmentMap, maxN: number): string[] {
  const output: string[] = []
  // Length cap: 2× input tokens + small absolute buffer
  const maxOutputTokens = tokens.length * OUTPUT_LENGTH_FACTOR + OUTPUT_LENGTH_ABS_CAP

  // What the model has wanted to emit at each prior position, whether or not
  // the guard actually let it through. Tracking intent (not just what made it
  // into `output`) is what lets the guard keep recognizing an ongoing cycle
  // across an interrupting literal fallback — otherwise a single interruption
  // would look like a break and the cycle would resume right after it.
  const modelIntentHistory: string[] = []

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
        const suppressed = formsExcessiveCycle(modelIntentHistory, bestSrc)
        modelIntentHistory.push(bestSrc)

        if (suppressed) {
          // Cycling — fall through to the literal fallback below.
          break
        }

        pushDeduped(output, bestSrc)
        i += n
        matched = true
        break
      }
    }

    if (!matched) {
      // Literal fallback — keep the target token as-is, pushed plainly (not
      // deduped): if the target genuinely repeats a word, the literal copy
      // must reflect that rather than silently dropping it. Not tracked in
      // modelIntentHistory either: it's not something the model chose, so it
      // shouldn't count as breaking or extending a cycle.
      output.push(tokens[i])
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
