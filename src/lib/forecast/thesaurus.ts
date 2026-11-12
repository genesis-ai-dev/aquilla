/**
 * thesaurus.ts — "words that fit here": the BIA engine with the word blanked
 * out of every cell that contains it, plus (with a source verse) the other
 * renderings of the source word(s) the selected word translates.
 */

import type { BiaEngine } from "./bia-engine"
import { wordKeys } from "./forecast-tokenize"
import { mixScores } from "./mix"

export const THESAURUS_ANCHORS = 7
export const THESAURUS_SAMPLES = 100
const THESAURUS_PER_SAMPLE = 20

export interface ThesaurusOptions {
  context?: { left: string; right: string }
  limit?: number
  samples?: number
  excludeCellId?: string
  /** "idf2" = the Python `combine_votes`; "votes" (default) = vote share. */
  weighting?: "idf2" | "votes"
  /** The verse's source: words translating the same source word rank up. */
  source?: string | readonly string[]
  sourceWeight?: number
}

/**
 * Thesaurus: words that fit where `word` fits (Python `synonimize` +
 * `combine_votes`). With `context`, the sentence being edited is one more
 * sample, so the list also reflects "here".
 */
export function wordsThatFit(
engine: BiaEngine,
word: string,
opts: ThesaurusOptions,
defaults: { decay: number; sourceWeight: number },
): Array<{ word: string; score: number }> {
  const target = wordKeys(word)[0]
  if (!target) return []
  const { index } = engine
  const posting = index.postingsOf(target)
  const sampleIds = posting ? Array.from(posting.keys()) : []
  const orders = sampleIds.map((id) => index.cell(id)?.order ?? 0)
  const bound: readonly [number, number] | undefined =
    orders.length > 0 ? [Math.min(...orders), Math.max(...orders)] : undefined
  sampleIds.sort((a, b) => (index.cell(a)?.order ?? 0) - (index.cell(b)?.order ?? 0))
  const cap = opts.samples ?? THESAURUS_SAMPLES
  const step = Math.max(1, Math.floor(sampleIds.length / cap))
  const samples: Array<{ tokens: readonly string[]; at: number }> = []
  for (let i = 0; i < sampleIds.length; i += step) {
    const id = sampleIds[i]
    if (id === opts.excludeCellId) continue
    const cell = index.cell(id)
    const at = posting?.get(id)
    if (cell && at !== undefined) samples.push({ tokens: cell.tokens, at })
  }
  if (opts.context) {
    const left = wordKeys(opts.context.left)
    samples.push({ tokens: [...left, target, ...wordKeys(opts.context.right)], at: left.length })
  }

  const faithful = opts.weighting === "idf2"
  const combined = new Map<string, number>()
  for (const sample of samples) {
    const ranked = engine.predictAt(sample.tokens, sample.at, {
      topN: THESAURUS_ANCHORS,
      bound,
      excludeCellId: opts.excludeCellId,
      decay: faithful ? 0 : defaults.decay,
    }).filter(([candidate]) => candidate !== target)
    if (faithful) {
      for (const [candidate] of ranked) {
        const idf = index.idf(candidate)
        combined.set(candidate, (combined.get(candidate) ?? 0) + idf * idf)
      }
      continue
    }
    // Default weighting keeps the Python's IDF² but scales it by the
    // candidate's vote share in the sample (a stray single-anchor landing
    // scores little) over the top THESAURUS_PER_SAMPLE candidates that the
    // Markov chain allows between the blank's neighbours. The faithful
    // IDF²-for-every-candidate ranks hapaxes first (pace, processions,
    // bereaving for "king"); this gives men, people, house, father.
    const prev = sample.tokens[sample.at - 1]
    const next = sample.tokens[sample.at + 1]
    const fitsLeft = (c: string) => prev === undefined || index.canBeNext(prev, c)
    const fitsRight = (c: string) => next === undefined || index.canPrecede(c, next)
    // Both neighbours when possible; one side when a rare neighbour (only
    // ever seen beside the word itself) would otherwise rule out everything.
    let fitting = ranked.filter(([c]) => fitsLeft(c) && fitsRight(c))
    if (fitting.length === 0) fitting = ranked.filter(([c]) => fitsLeft(c) || fitsRight(c))
    const top = fitting[0]?.[1] ?? 0
    for (const [candidate, votes] of fitting.slice(0, THESAURUS_PER_SAMPLE)) {
      const idf = index.idf(candidate)
      combined.set(candidate, (combined.get(candidate) ?? 0) + (votes / top) * idf * idf)
    }
  }
  combined.delete(target)
  const source = typeof opts.source === "string" ? wordKeys(opts.source) : (opts.source ?? [])
  const alpha = opts.sourceWeight ?? defaults.sourceWeight
  const scored = source.length > 0 && alpha > 0
    ? mixScores(engine.rank(combined), sourceAlternatives(engine, target, source, opts.excludeCellId), alpha)
    : combined
  scored.delete(target)
  const total = Array.from(scored.values()).reduce((a, b) => a + b, 0)
  return engine.rank(scored)
    .slice(0, opts.limit ?? 10)
    .map(([w, s]) => ({ word: index.display(w), score: total > 0 ? s / total : 0 }))
}

/**
 * Other target words for the source word(s) `target` translates here:
 * sum over the verse's source words s of idf(s) * dice(s, target) * dice(s, t).
 */
function sourceAlternatives(engine: BiaEngine, target: string, source: readonly string[], excludeCellId?: string): Map<string, number> {
  const { lexicon } = engine.index
  const pairs = lexicon.pairCount
  const out = new Map<string, number>()
  for (const s of new Set(source)) {
    const assoc = lexicon.associations(s, excludeCellId)
    const anchor = assoc.find(([t]) => t === target)?.[1] ?? 0
    if (anchor === 0) continue
    const weight = lexicon.idf(s, pairs) * anchor
    for (const [t, d] of assoc) out.set(t, (out.get(t) ?? 0) + weight * d)
  }
  return out
}
