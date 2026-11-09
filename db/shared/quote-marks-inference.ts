// Infer a project's quotation system from its own text (AQU-1733).
//
// Paratext makes the user fill in a quotation-rules form — up to nine nesting
// levels — before any quotation check can run. Aquilla has the same shape of
// data (`LanguageProfile.quoteMarks`, AQU-1688) and the same problem: the
// quotation checks (bkp:V1/V2/V3/V5/V7/V8/V9) stay dormant until somebody
// types the marks in. But a project that has translated anything has already
// SHOWN which marks it uses, so the marks can be read off the text and offered
// for the project lead to confirm or edit.
//
// What is inferred, and from what evidence:
//
//   levels       Every candidate pair is scored by how much of the sample it
//                accounts for (complete pairs count double; a lone opening
//                mark still scores, so a passage whose only quotation is the
//                unclosed one is still evidence). Pairs are then taken
//                greedily, skipping any that reuses a character an earlier
//                level already claimed — „ … “ and “ … ” share “, and a
//                profile whose levels overlap would make every mark ambiguous.
//   nesting      Level order comes from where each pair is OBSERVED: the text
//                is walked with a stack, each opening mark records the depth
//                it opened at, and pairs are ordered by their mean depth. So
//                English “…‘…’…” yields “ ” then ‘ ’ because ‘ is only ever
//                seen inside “.
//   continuation Looked for only where it can be seen: a text in the sample
//                that STARTS while a quotation opened by an earlier text is
//                still open. An opening mark there means the convention
//                reopens each paragraph; a closing mark there means a
//                continuation mark. With no such place in the sample there is
//                no evidence either way, and the forgiving convention is the
//                right default for a checker, so `reopen-each-paragraph`
//                stands (it is also what `defaultQuoteMarks` assumes).
//
// Deterministic and dependency-free: no model, no network, relative imports
// only, so the workers can use it too. The sample is ordered — pass the cells
// of a project (or a file) in reading order, because the continuation evidence
// is about what happens at the seam between two cells.

import { MAX_QUOTE_LEVELS, type QuoteContinuationStyle, type QuoteMarkPair, type QuoteMarksProfile } from './language-profile'

/**
 * The pairs worth looking for, in the order that breaks ties. Every entry is
 * a convention some published translation uses; a pair that scores zero in the
 * sample is never put in the profile, so listing one costs nothing.
 */
export const CANDIDATE_QUOTE_PAIRS: readonly QuoteMarkPair[] = [
  { open: '“', close: '”' },
  { open: '«', close: '»' },
  { open: '‘', close: '’' },
  { open: '„', close: '“' },
  { open: '„', close: '”' },
  { open: '»', close: '«' },
  { open: '‚', close: '‘' },
  { open: '「', close: '」' },
  { open: '『', close: '』' },
  { open: '〝', close: '〞' },
  { open: '"', close: '"' },
]

/** A mark that is also an apostrophe needs more evidence before it is a level. */
const APOSTROPHE_LIKE: ReadonlySet<string> = new Set(['’', "'"])
const WORD_CHAR = /[\p{L}\p{N}]/u
const WHITESPACE = /\s/u

function countChar(text: string, mark: string): number {
  let n = 0
  for (const ch of text) if (ch === mark) n++
  return n
}

/**
 * Occurrences of `mark` that are not an apostrophe inside a word: `don’t` must
 * not make ‘ ’ the project's quotation pair.
 */
function countMark(text: string, mark: string): number {
  if (!APOSTROPHE_LIKE.has(mark)) return countChar(text, mark)
  let n = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== mark) continue
    const before = i > 0 ? text[i - 1] : ''
    const after = i + 1 < text.length ? text[i + 1] : ''
    if (before && after && WORD_CHAR.test(before) && WORD_CHAR.test(after)) continue
    n++
  }
  return n
}

/**
 * How much of the sample a pair accounts for. Complete pairs count double so a
 * balanced pair always beats an unbalanced one of the same frequency; a lone
 * opening mark adds one, which is what lets a project whose only quotation was
 * left unclosed still learn its pair.
 */
export function quotePairScore(texts: readonly string[], pair: QuoteMarkPair): number {
  const joined = texts.join('\n')
  const opens = countMark(joined, pair.open)
  if (pair.open === pair.close) return opens
  const closes = countMark(joined, pair.close)
  return 2 * Math.min(opens, closes) + (opens > 0 ? 1 : 0)
}

function charsOf(pair: QuoteMarkPair): string[] {
  return pair.open === pair.close ? [pair.open] : [pair.open, pair.close]
}

/** Score every candidate, keep the ones the sample shows, and drop any pair
 *  that reuses a character a better-scoring level already claimed. */
function pickPairs(texts: readonly string[]): QuoteMarkPair[] {
  const scored = CANDIDATE_QUOTE_PAIRS.map((pair, index) => ({ pair, index, score: quotePairScore(texts, pair) }))
    .filter((entry) => entry.score > 0)
    // Descending score, then the candidate order, so the result never depends
    // on the engine's sort stability.
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))

  const taken: QuoteMarkPair[] = []
  const claimed = new Set<string>()
  for (const { pair } of scored) {
    if (taken.length >= MAX_QUOTE_LEVELS) break
    if (charsOf(pair).some((ch) => claimed.has(ch))) continue
    taken.push(pair)
    for (const ch of charsOf(pair)) claimed.add(ch)
  }
  return taken
}

/**
 * Order the pairs by the nesting depth they are seen at. The walk keeps a
 * stack of open quotations over all the picked pairs at once, so a mark that
 * only ever appears inside another pair's quotation sorts below it.
 */
function orderByObservedDepth(texts: readonly string[], pairs: readonly QuoteMarkPair[]): QuoteMarkPair[] {
  if (pairs.length < 2) return [...pairs]
  const key = (pair: QuoteMarkPair) => `${pair.open}\u0000${pair.close}`
  const depthSum = new Map<string, number>()
  const depthCount = new Map<string, number>()
  const openers = new Map<string, QuoteMarkPair>()
  const closers = new Map<string, QuoteMarkPair>()
  for (const pair of pairs) {
    openers.set(pair.open, pair)
    if (pair.open !== pair.close) closers.set(pair.close, pair)
  }

  for (const text of texts) {
    const stack: QuoteMarkPair[] = []
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (APOSTROPHE_LIKE.has(ch)) {
        const before = i > 0 ? text[i - 1] : ''
        const after = i + 1 < text.length ? text[i + 1] : ''
        if (before && after && WORD_CHAR.test(before) && WORD_CHAR.test(after)) continue
      }
      const top = stack[stack.length - 1]
      if (top && ch === top.close) {
        stack.pop()
        continue
      }
      const opener = openers.get(ch)
      if (!opener) continue
      const k = key(opener)
      depthSum.set(k, (depthSum.get(k) ?? 0) + stack.length)
      depthCount.set(k, (depthCount.get(k) ?? 0) + 1)
      stack.push(opener)
    }
  }

  const meanDepth = (pair: QuoteMarkPair): number => {
    const k = key(pair)
    const n = depthCount.get(k) ?? 0
    return n === 0 ? Number.POSITIVE_INFINITY : (depthSum.get(k) ?? 0) / n
  }
  const order = new Map(pairs.map((pair, index) => [key(pair), index]))
  return [...pairs].sort((a, b) => {
    const d = meanDepth(a) - meanDepth(b)
    if (d !== 0 && Number.isFinite(d)) return d
    if (d !== 0) return meanDepth(a) === Number.POSITIVE_INFINITY ? 1 : -1
    return (order.get(key(a)) ?? 0) - (order.get(key(b)) ?? 0)
  })
}

/** The first character of `text` that is not whitespace, or ''. */
function firstVisibleChar(text: string): string {
  for (const ch of text) if (!WHITESPACE.test(ch)) return ch
  return ''
}

/**
 * How many levels of `pairs` are still open after `text`, starting from
 * `startDepth` levels already open. Only the depth matters here, so the walk
 * does not need the full classifier in bible-checks/quote-scan.ts.
 */
function carryDepth(text: string, pairs: readonly QuoteMarkPair[], startDepth: number): number {
  let depth = startDepth
  const openers = new Set(pairs.map((p) => p.open))
  const closers = new Set(pairs.filter((p) => p.open !== p.close).map((p) => p.close))
  const symmetric = new Set(pairs.filter((p) => p.open === p.close).map((p) => p.open))
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (APOSTROPHE_LIKE.has(ch)) {
      const before = i > 0 ? text[i - 1] : ''
      const after = i + 1 < text.length ? text[i + 1] : ''
      if (before && after && WORD_CHAR.test(before) && WORD_CHAR.test(after)) continue
    }
    if (symmetric.has(ch)) depth = depth > 0 ? depth - 1 : 1
    else if (closers.has(ch)) depth = Math.max(0, depth - 1)
    else if (openers.has(ch)) depth++
  }
  return depth
}

/**
 * The paragraph convention the sample shows, read at the seams: a text that
 * begins while an earlier text's quotation is still open. No seam in the
 * sample means no evidence, and the default stands.
 */
export function inferQuoteContinuation(
  texts: readonly string[],
  pairs: readonly QuoteMarkPair[],
): { style: QuoteContinuationStyle; seams: number } {
  if (pairs.length === 0) return { style: 'reopen-each-paragraph', seams: 0 }
  const opens = new Set(pairs.map((p) => p.open))
  const closes = new Set(pairs.filter((p) => p.open !== p.close).map((p) => p.close))
  let reopen = 0
  let continuation = 0
  let bare = 0
  let depth = 0
  for (const text of texts) {
    if (depth > 0 && text.trim() !== '') {
      const first = firstVisibleChar(text)
      // A symmetric mark is both; it cannot tell the two conventions apart.
      if (closes.has(first)) continuation++
      else if (opens.has(first)) reopen++
      else bare++
    }
    depth = carryDepth(text, pairs, depth)
  }
  const seams = reopen + continuation + bare
  if (seams === 0) return { style: 'reopen-each-paragraph', seams }
  if (reopen >= continuation && reopen >= bare) return { style: 'reopen-each-paragraph', seams }
  if (continuation >= bare) return { style: 'continuation-mark', seams }
  return { style: 'none', seams }
}

export interface InferQuoteMarksOptions {
  /**
   * The validated cells' text. Validated work is what the project has agreed
   * to, so it decides whenever any of it quotes anything; `texts` is the
   * fallback for a project with nothing validated yet.
   */
  validatedTexts?: readonly string[]
}

/**
 * The quotation system the sample shows, or null when it shows none — a
 * project that has not quoted anything yet has nothing to be consistent with,
 * and guessing a profile there would only make the checks fire on text that
 * never used the marks guessed.
 *
 * `texts` is in reading order (see the continuation note in the header).
 */
export function inferQuoteMarks(
  texts: readonly string[],
  options: InferQuoteMarksOptions = {},
): QuoteMarksProfile | null {
  const validated = options.validatedTexts ?? []
  const fromValidated = pickPairs(validated)
  const sample = fromValidated.length > 0 ? validated : texts
  const picked = fromValidated.length > 0 ? fromValidated : pickPairs(texts)
  if (picked.length === 0) return null
  const levels = orderByObservedDepth(sample, picked)
  return { levels, continuation: inferQuoteContinuation(sample, levels).style }
}
