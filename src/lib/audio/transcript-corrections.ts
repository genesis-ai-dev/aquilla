/**
 * AQU-463 — the transcription correction-learning loop.
 *
 * Low-resource ASR is usually wrong the SAME way every time: Whisper has no
 * lexicon for the language, so a name or a common word comes back as the same
 * plausible-sounding mistake in clip after clip. The translator already fixes
 * it once, in the transcript editor. This module is what makes the second fix
 * unnecessary — it reads the correction the human just made, keeps the
 * `heard → corrected` pair, and replays it over every later transcript for the
 * same project.
 *
 * Two deliberate constraints, both load-bearing:
 *
 * 1. **Single token in, single token out.** Word timings are positional — the
 *    karaoke band, `alignChunks`, and `remapTranscriptTimings` all key off the
 *    token count. A 1:1 substitution rewrites a word without moving anything
 *    around it, so learned corrections can be applied to a fresh transcript
 *    with the timings left exactly as ASR produced them. Learning "these three
 *    words become two" would break that invariant, so we don't learn it.
 * 2. **A rewrite is not a correction.** If the human replaced most of the
 *    transcript, that is them typing what they hear, not teaching us a
 *    consistent ASR error — inferring rules from it would poison the store
 *    with one-off vocabulary. Past `MAX_CHANGED_RATIO` we learn nothing.
 *
 * Pure functions only; persistence lives in
 * `@/lib/store/transcript-corrections-store`.
 */

import { tokenizeWords } from "./timings"

export interface CorrectionRule {
  /** Normalized form ASR produced — the lookup key. */
  heard: string
  /** Replacement core as the human typed it (their capitalization kept). */
  corrected: string
  /** How many times a human has made this same correction. */
  count: number
  /** Epoch ms of the most recent reinforcement — drives eviction. */
  updatedAt: number
}

/** Beyond this share of changed tokens the edit reads as a rewrite, not a correction. */
export const MAX_CHANGED_RATIO = 0.5

/** Rules kept per project. Least-recently-reinforced are evicted past this. */
export const MAX_RULES = 200

/**
 * Split a token into leading punctuation, the comparable core, and trailing
 * punctuation. Whisper's punctuation is its own guess and the human retypes it
 * freely, so it must not be part of what we match on — otherwise `"kilisusu,"`
 * and `"kilisusu"` are two unrelated rules.
 */
export function splitToken(token: string): { lead: string; core: string; trail: string } {
  const match = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(token)
  if (!match) return { lead: "", core: token, trail: "" }
  return { lead: match[1], core: match[2], trail: match[3] }
}

/** The match key for a token: its core, lowercased. Empty for pure punctuation. */
export function normalizeToken(token: string): string {
  return splitToken(token).core.toLocaleLowerCase()
}

/**
 * Re-apply the shape of `model` to `replacement`: all-caps stays all-caps, a
 * leading capital stays capitalized. A learned rule is stored once but lands
 * mid-sentence and sentence-initially, and the transcript should not sprout
 * lowercase words at the start of lines.
 */
export function matchCase(model: string, replacement: string): string {
  if (!model || !replacement) return replacement
  const hasLower = model !== model.toLocaleUpperCase()
  if (!hasLower && model.length > 1) return replacement.toLocaleUpperCase()
  const first = model[0]
  if (first === first.toLocaleUpperCase() && first !== first.toLocaleLowerCase()) {
    return replacement[0].toLocaleUpperCase() + replacement.slice(1)
  }
  return replacement
}

/**
 * Longest common subsequence over normalized tokens, returned as index pairs.
 * Transcripts are a line at a time, so the quadratic table is a few hundred
 * cells at worst.
 */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  return pairs
}

/**
 * Read the `heard → corrected` pairs out of one human correction.
 *
 * Only runs of exactly one replaced token against one replacement token
 * become pairs — see the single-token constraint at the top of the file. Pure
 * insertions and deletions teach us nothing transferable and are dropped.
 */
export function extractCorrections(original: string, corrected: string): Array<{ heard: string; corrected: string }> {
  const originalTokens = tokenizeWords(original).map((w) => w.word)
  const correctedTokens = tokenizeWords(corrected).map((w) => w.word)
  if (originalTokens.length === 0 || correctedTokens.length === 0) return []

  const a = originalTokens.map(normalizeToken)
  const b = correctedTokens.map(normalizeToken)
  const anchors = lcsPairs(a, b)

  // Walk the gaps between anchors; a gap of one-on-one is a substitution.
  const pairs: Array<{ heard: string; corrected: string }> = []
  let changedTokens = 0
  let ai = 0
  let bi = 0
  const steps = [...anchors, [originalTokens.length, correctedTokens.length] as [number, number]]
  for (const [anchorA, anchorB] of steps) {
    const gapA = anchorA - ai
    const gapB = anchorB - bi
    changedTokens += Math.max(gapA, gapB)
    if (gapA === 1 && gapB === 1) {
      const heard = a[ai]
      const replacement = splitToken(correctedTokens[bi]).core
      // An identity pair (pure punctuation or case edit) would rewrite every
      // later transcript to no effect; a coreless token has nothing to match.
      if (heard && replacement && heard !== replacement.toLocaleLowerCase()) {
        pairs.push({ heard, corrected: replacement })
      }
    }
    ai = anchorA + 1
    bi = anchorB + 1
  }

  const denominator = Math.max(originalTokens.length, correctedTokens.length)
  if (denominator > 0 && changedTokens / denominator > MAX_CHANGED_RATIO) return []
  return pairs
}

/**
 * Fold new pairs into an existing rule set. A repeat correction reinforces its
 * rule (`count`) rather than duplicating it; a human who corrects the same
 * word to something NEW has changed their mind, and the newer answer wins.
 */
export function learnCorrections(
  rules: readonly CorrectionRule[],
  pairs: ReadonlyArray<{ heard: string; corrected: string }>,
  now: number = Date.now(),
): CorrectionRule[] {
  if (pairs.length === 0) return [...rules]
  const byHeard = new Map(rules.map((r) => [r.heard, { ...r }]))
  for (const pair of pairs) {
    const existing = byHeard.get(pair.heard)
    if (existing) {
      existing.count += 1
      existing.corrected = pair.corrected
      existing.updatedAt = now
    } else {
      byHeard.set(pair.heard, { heard: pair.heard, corrected: pair.corrected, count: 1, updatedAt: now })
    }
  }
  const next = [...byHeard.values()].sort((x, y) => y.updatedAt - x.updatedAt)
  return next.slice(0, MAX_RULES)
}

/**
 * Replay learned corrections over a fresh transcript.
 *
 * Whole tokens only, matched on the normalized core, with the original's
 * punctuation and capitalization preserved — so the token count (and every
 * word timing indexed by it) is untouched.
 */
export function applyCorrections(text: string, rules: readonly CorrectionRule[]): string {
  if (!text || rules.length === 0) return text
  const byHeard = new Map(rules.map((r) => [r.heard, r.corrected]))
  const tokens = tokenizeWords(text)
  if (tokens.length === 0) return text

  let out = ""
  let cursor = 0
  for (const token of tokens) {
    const { lead, core, trail } = splitToken(token.word)
    const replacement = core ? byHeard.get(core.toLocaleLowerCase()) : undefined
    out += text.slice(cursor, token.start)
    out += replacement ? lead + matchCase(core, replacement) + trail : token.word
    cursor = token.end
  }
  return out + text.slice(cursor)
}
