/**
 * bia-eval.ts — offline accuracy harness for BIA forecasting.
 *
 * Pure: give it training cells and held-out texts, get next-word and infill
 * top-1 / top-3 accuracy for BIA and its baselines. `scripts/bia-eval.ts`
 * runs it over eBible corpora; `bia-eval.test.ts` runs it on a fixture.
 */

import { fold, wordKeys } from "./forecast-tokenize"
import { BiaEngine, FAITHFUL_OPTIONS, type SuggestOptions } from "./bia-engine"
import { BiaIndex, type BiaIndexOptions, type ForecastCell } from "./bia-index"

export interface Accuracy {
  top1: number
  top3: number
  /** Share of positions where the method offered anything at all. */
  coverage: number
  n: number
  /** Mean wall time per prediction, milliseconds. */
  ms: number
}

export interface EvalReport {
  trainCells: number
  testCells: number
  next: Record<string, Accuracy>
  infill: Record<string, Accuracy>
  msPerQuery: number
}

export interface EvalOptions {
  /** Cap on scored positions per task (deterministic stride sampling). */
  maxPositions?: number
  /**
   * "baseline" (default): the BIA ablations against unigram/bigram.
   * "source": no-source vs with-source on the same positions (test items
   * must carry their source verse), plus a source-only ablation.
   * "variants": only the given SuggestOptions variants (tuning).
   */
  methods?: "baseline" | "source" | "variants"
  variants?: Record<string, SuggestOptions>
  /** Index construction options (e.g. the stem length). */
  index?: BiaIndexOptions
}

/** A held-out verse: its target text, and its source when evaluating alignment. */
export type EvalItem = string | { text: string; source?: string }

export const FAITHFUL = "bia faithful (python: markov filter)"
export const SHIPPED = "bia shipped (decay + markov weight + fallback)"
export const NO_SOURCE = "BIA"
export const WITH_CHAINS = "BIA + chains (no source)"
export const WITH_SOURCE = "BIA + source"
export const SOURCE_ONLY = "source lexicon only"

type Predictor = (left: string[], right: string[], source: string | undefined) => string[]

class Tally {
  private hits1 = 0
  private hits3 = 0
  private offered = 0
  private n = 0
  add(predicted: readonly string[], gold: string): void {
    this.n++
    if (predicted.length > 0) this.offered++
    if (predicted[0] === gold) this.hits1++
    if (predicted.slice(0, 3).includes(gold)) this.hits3++
  }
  result(elapsedMs = 0): Accuracy {
    const d = Math.max(1, this.n)
    return { top1: this.hits1 / d, top3: this.hits3 / d, coverage: this.offered / d, n: this.n, ms: elapsedMs / d }
  }
}

/** Every (cell, position) pair, thinned to at most `max` by a fixed stride. */
function positions(tests: readonly string[][], minIndex: number, trailing: number, max: number): Array<[number, number]> {
  const all: Array<[number, number]> = []
  tests.forEach((tokens, c) => {
    for (let i = minIndex; i < tokens.length - trailing; i++) all.push([c, i])
  })
  if (all.length <= max) return all
  const stride = all.length / max
  return Array.from({ length: max }, (_, k) => all[Math.floor(k * stride)])
}

export function runForecastEval(train: readonly ForecastCell[], testItems: readonly EvalItem[], opts: EvalOptions = {}): EvalReport {
  const index = new BiaIndex(opts.index)
  index.upsert(train)
  const engine = new BiaEngine(index)
  const unigram = index.vocabularyByFrequency().slice(0, 3).map(([w]) => w)
  const items = testItems
    .map((item) => (typeof item === "string" ? { text: item } : item))
    .map((item) => ({ tokens: wordKeys(item.text), source: item.source }))
    .filter((item) => item.tokens.length > 1)
  const tests = items.map((item) => item.tokens)
  const max = opts.maxPositions ?? 2000

  const bigramNext = (prev: string | undefined): string[] => {
    const followers = prev === undefined ? [] : index.followers(prev).slice(0, 3).map(([w]) => w)
    return followers.length > 0 ? followers : unigram
  }
  const bia = (o: SuggestOptions): Predictor => (left, right, source) => {
    const withSource = o.sourceWeight !== 0 && source ? { ...o, source } : o
    return (right.length === 0
      ? engine.suggestNext(`${left.join(" ")} `, { ...withSource, extend: false, limit: 3 })
      : engine.suggestInfill(`${left.join(" ")} `, ` ${right.join(" ")}`, { ...withSource, limit: 3 })
    ).map((s) => fold(s.word))
  }
  const biaMethods: Record<string, Predictor> =
    opts.methods === "variants"
      ? Object.fromEntries(Object.entries(opts.variants ?? {}).map(([name, o]) => [`bia ${name}`, bia(o)]))
      : opts.methods === "source"
        ? {
            [NO_SOURCE]: bia({ sourceWeight: 0, chains: false }),
            [WITH_CHAINS]: bia({ sourceWeight: 0 }),
            [WITH_SOURCE]: bia({}),
            ["bia " + SOURCE_ONLY]: bia({ sourceWeight: 1000 }),
          }
        : {
            [FAITHFUL]: bia(FAITHFUL_OPTIONS),
            "bia votes only (no markov)": bia({ ...FAITHFUL_OPTIONS, markov: "off" }),
            "bia + markov weight": bia({ ...FAITHFUL_OPTIONS, markov: "weight" }),
            [SHIPPED]: bia({ sourceWeight: 0, chains: false }),
          }
  const baselines = opts.methods !== "variants"

  const nextMethods: Record<string, Predictor> = {
    ...(baselines ? { "unigram": () => unigram, "bigram-markov": (left: string[]) => bigramNext(left.at(-1)) } : {}),
    ...biaMethods,
  }
  const infillMethods: Record<string, Predictor> = {
    ...(baselines ? { "unigram": (): string[] => unigram, "bigram-markov": bigramInfill } : {}),
    ...biaMethods,
  }

  function bigramInfill(left: string[], right: string[]): string[] {
      const prev = left.at(-1)
      const next = right[0]
      if (prev === undefined) return unigram
      const ranked = index
        .followers(prev)
        .map(([w, c]): [string, number] => [w, c * (index.bigram(w, next) + 0.01)])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([w]) => w)
      return ranked.length > 0 ? ranked : unigram
  }

  let queries = 0
  const started = Date.now()
  const score = (methods: Record<string, Predictor>, pts: Array<[number, number]>, infill: boolean) => {
    const out: Record<string, Accuracy> = {}
    for (const [name, predict] of Object.entries(methods)) {
      const tally = new Tally()
      const t0 = performance.now()
      for (const [c, i] of pts) {
        const tokens = tests[c]
        const predicted = predict(tokens.slice(0, i), infill ? tokens.slice(i + 1) : [], items[c].source)
        if (name !== "unigram" && name !== "bigram-markov") queries++
        tally.add(predicted, tokens[i])
      }
      out[name] = tally.result(performance.now() - t0)
    }
    return out
  }
  const next = score(nextMethods, positions(tests, 1, 0, max), false)
  const infill = score(infillMethods, positions(tests, 1, 1, max), true)
  return {
    trainCells: index.size,
    testCells: tests.length,
    next,
    infill,
    msPerQuery: queries > 0 ? (Date.now() - started) / queries : 0,
  }
}

/** Split vref-aligned verse lines into train cells and held-out texts (every `k`th verse). */
export function splitHeldOut(lines: readonly string[], k = 10, trainLimit?: number): { train: ForecastCell[]; test: string[] } {
  const train: ForecastCell[] = []
  const test: string[] = []
  let kept = 0
  lines.forEach((line, i) => {
    const text = line.trim()
    if (!text) return
    if (kept++ % k === k - 1) test.push(text)
    else if (trainLimit === undefined || train.length < trainLimit) {
      train.push({ id: `v${i}`, text, validated: true, order: i })
    }
  })
  return { train, test }
}

/**
 * Split two vref-aligned files (source, target) into paired train cells and
 * held-out items, keeping only verses present in both. Every `k`th pair is
 * held out; `trainLimit` keeps the first N training pairs (early project).
 */
export function splitParallel(
  sourceLines: readonly string[],
  targetLines: readonly string[],
  k = 10,
  trainLimit?: number,
): { train: ForecastCell[]; test: Array<{ text: string; source: string }> } {
  const train: ForecastCell[] = []
  const test: Array<{ text: string; source: string }> = []
  let kept = 0
  targetLines.forEach((line, i) => {
    const text = line.trim()
    const source = (sourceLines[i] ?? "").trim()
    if (!text || !source) return
    if (kept++ % k === k - 1) test.push({ text, source })
    else if (trainLimit === undefined || train.length < trainLimit) {
      train.push({ id: `v${i}`, text, source, validated: true, order: i })
    }
  })
  return { train, test }
}

/** Carve a tuning split out of TRAINING cells: every `k`th becomes a dev item. */
export function devSplit(train: readonly ForecastCell[], k = 10): { train: ForecastCell[]; dev: Array<{ text: string; source?: string }> } {
  const kept: ForecastCell[] = []
  const dev: Array<{ text: string; source?: string }> = []
  train.forEach((cell, i) => {
    if (i % k === k - 1) dev.push({ text: cell.text, source: cell.source })
    else kept.push(cell)
  })
  return { train: kept, dev }
}
